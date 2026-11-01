// 受控消融：哪个 puppeteer 启动因素导致 Google Lens GOOGLE_CAPTCHA。
// 协议：3 轮，每轮 CTRL → D0..D6（mulberry32(7+round) 洗牌）→ CTRL；相邻查询间隔 20s；
//       一轮两个 CTRL 都 captcha → 该轮标 ip-flagged，等 10 分钟重跑一次。
//       3 轮后追加一组长存 D0 序列（同一个 App/浏览器连发 3 次，间隔 20s）。
// 用法: node scripts/lens-ablation.mjs [image]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const imagePath = process.argv[2] || path.join(ROOT, 'test/local/images/sample-1.png')
const bytes = fs.readFileSync(imagePath)
const ORIG_DIR = path.join(ROOT, 'test/local/original')
const OUT_FILE = path.join(ROOT, 'test/local/runs/ablation.json')
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })

const { App } = require('koishi')
const httpMod = require('@cordisjs/plugin-http')
const puppeteerMod = require('koishi-plugin-puppeteer')
const { FishBrowser, PAGE_PROFILE } = require('../lib/browser.js')
const engines = require('../lib/engines.js')
const { BROWSER_UA_CHROME: UA } = require('../lib/constants.js')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const D4_PROFILE = path.resolve(ROOT, 'test/local/ablation/D4-profile')
const D5_PROFILE = path.resolve(ROOT, 'test/local/ablation/D5-profile')

const TRIALS = {
  D0: () => ({}),
  D1: () => ({ args: ['--disable-blink-features=AutomationControlled'] }),
  D2: () => ({ ignoreDefaultArgs: ['--enable-automation'] }),
  D3: () => ({ executablePath: EDGE }),
  D4: () => ({ userDataDir: D4_PROFILE }),
  D5: () => ({ executablePath: EDGE, args: ['--disable-blink-features=AutomationControlled', '--lang=zh-CN', `--user-agent=${UA}`], ignoreDefaultArgs: ['--enable-automation'], userDataDir: D5_PROFILE }),
  D6: () => ({}), // 同 D0，但 trial 前把 PAGE_PROFILE.userAgentMetadata 换成真实 Chrome brands
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const shuffle = (arr, rng) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const results = []
const pids = new Set()
let lastQueryAt = 0
async function throttle() {
  const wait = 20000 - (Date.now() - lastQueryAt)
  if (wait > 0) await sleep(wait)
}
const record = (entry) => {
  results.push(entry)
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2))
  console.log(`  [${entry.id}#${entry.order}] ${entry.outcome} rows=${entry.rows} ${entry.elapsedMs}ms${entry.error ? ' err=' + entry.error : ''}`)
}

function classify(error, rows) {
  if (!error) return { outcome: 'ok', rows: rows?.length ?? 0, error: '' }
  const msg = String(error?.message ?? error)
  return { outcome: msg.startsWith('GOOGLE_CAPTCHA') ? 'captcha' : 'error', rows: 0, error: msg }
}

async function runTrial(id, round, order) {
  await throttle()
  const started = Date.now()
  const startIso = new Date(started).toISOString()
  let app, browserVersion = '', executable = ''
  const savedMeta = PAGE_PROFILE.userAgentMetadata
  try {
    app = new App()
    app.plugin(httpMod.default ?? httpMod)
    app.plugin(puppeteerMod.default ?? puppeteerMod, TRIALS[id]())
    await app.start()
    const browser = new FishBrowser(app, {})
    try { browserVersion = await app.puppeteer.browser.version() } catch {}
    try { executable = app.puppeteer.executable || app.puppeteer.browser?.process?.()?.spawnfile?.() || '' } catch {}
    try { const p = app.puppeteer.browser?.process?.(); if (p?.pid) pids.add(p.pid) } catch {}
    if (id === 'D6') {
      const major = String(browserVersion).split('.')[0] || '141'
      PAGE_PROFILE.userAgentMetadata = {
        ...savedMeta,
        brands: [
          { brand: 'Not:A-Brand', version: '8' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major }
        ],
        fullVersion: browserVersion || savedMeta.fullVersion
      }
    }
    let rows = null, error = null
    try {
      rows = await engines.googleLensSearch(browser, bytes, 'image/png', { timeoutMs: 45000 })
    } catch (e) { error = e }
    try { await browser.dispose() } catch {}
    const { outcome, error: errText } = classify(error, rows)
    record({ round, order, id, startIso, elapsedMs: Date.now() - started, outcome, rows: rows?.length ?? 0, error: errText, finalUrl: '', browserVersion, executable })
  } catch (e) {
    record({ round, order, id, startIso, elapsedMs: Date.now() - started, outcome: 'error', rows: 0, error: String(e?.message ?? e), finalUrl: '', browserVersion, executable })
  } finally {
    PAGE_PROFILE.userAgentMetadata = savedMeta
    try { await app?.stop() } catch {}
    lastQueryAt = Date.now()
  }
}

async function runCtrl(round, order) {
  await throttle()
  const started = Date.now()
  const startIso = new Date(started).toISOString()
  let executable = '', browserVersion = ''
  try {
    const mod = await import(pathToFileURL(path.join(ORIG_DIR, 'src/fish-find-chicken.js')).href)
    const CANDIDATES = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]
    executable = CANDIDATES.find((p) => fs.existsSync(p)) ?? ''
    let rows = null, error = null
    try {
      rows = await mod.googleLensSearch(bytes, 'image/png', { timeoutMs: 45000 })
    } catch (e) { error = e }
    try { await mod.closeBrowser() } catch {}
    const { outcome, error: errText } = classify(error, rows)
    record({ round, order, id: 'CTRL', startIso, elapsedMs: Date.now() - started, outcome, rows: rows?.length ?? 0, error: errText, finalUrl: '', browserVersion, executable })
    return outcome
  } catch (e) {
    record({ round, order, id: 'CTRL', startIso, elapsedMs: Date.now() - started, outcome: 'error', rows: 0, error: String(e?.message ?? e), finalUrl: '', browserVersion, executable })
    return 'error'
  } finally {
    lastQueryAt = Date.now()
  }
}

async function runRound(round) {
  let order = 0
  const c1 = await runCtrl(round, order++)
  const ids = shuffle(['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'], mulberry32(7 + round))
  for (const id of ids) await runTrial(id, round, order++)
  const c2 = await runCtrl(round, order++)
  return [c1, c2]
}

// 先准备 D4/D5 的全新 profile 目录
for (const d of [D4_PROFILE, D5_PROFILE]) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(d, { recursive: true })
}

for (let round = 0; round < 3; round++) {
  console.log(`=== round ${round} ===`)
  let [c1, c2] = await runRound(round)
  if (c1 === 'captcha' && c2 === 'captcha') {
    record({ round, order: -1, id: 'ip-flagged', startIso: new Date().toISOString(), elapsedMs: 0, outcome: 'ip-flagged', rows: 0, error: '', finalUrl: '', browserVersion: '', executable: '' })
    console.log('  !! 两个 CTRL 都 captcha —— 本轮记 ip-flagged，等 10 分钟重跑')
    await sleep(10 * 60 * 1000)
    ;[c1, c2] = await runRound(round)
  }
}

// 长存 D0 序列：同一个 App/默认浏览器连发 3 次
console.log('=== long-lived D0 sequence ===')
{
  let app
  try {
    app = new App()
    app.plugin(httpMod.default ?? httpMod)
    app.plugin(puppeteerMod.default ?? puppeteerMod, {})
    await app.start()
    const browser = new FishBrowser(app, {})
    let browserVersion = '', executable = ''
    try { browserVersion = await app.puppeteer.browser.version() } catch {}
    try { executable = app.puppeteer.executable || '' } catch {}
    for (let i = 0; i < 3; i++) {
      await throttle()
      const started = Date.now()
      let rows = null, error = null
      try {
        rows = await engines.googleLensSearch(browser, bytes, 'image/png', { timeoutMs: 45000 })
      } catch (e) { error = e }
      const { outcome, error: errText } = classify(error, rows)
      record({ round: 'seq', order: i, id: 'D0-seq', startIso: new Date(started).toISOString(), elapsedMs: Date.now() - started, outcome, rows: rows?.length ?? 0, error: errText, finalUrl: '', browserVersion, executable })
      lastQueryAt = Date.now()
    }
    try { await browser.dispose() } catch {}
  } catch (e) {
    record({ round: 'seq', order: -1, id: 'D0-seq', startIso: new Date().toISOString(), elapsedMs: 0, outcome: 'error', rows: 0, error: String(e?.message ?? e), finalUrl: '', browserVersion: '', executable: '' })
  } finally {
    try { await app?.stop() } catch {}
  }
}

fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2))
// 汇总
const tally = {}
for (const r of results.filter((r) => r.id.startsWith('D') || r.id === 'CTRL')) {
  const key = r.id
  tally[key] = tally[key] || {}
  tally[key][r.outcome] = (tally[key][r.outcome] ?? 0) + 1
}
console.log('\n=== tally ===')
console.log(JSON.stringify(tally, null, 2))
// 清理：只杀自己记录过的 pid
for (const pid of pids) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}
console.log('done')
