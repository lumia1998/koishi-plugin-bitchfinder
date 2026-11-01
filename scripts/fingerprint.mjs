// B2: 浏览器指纹对比 —— 原版自拉 headless Edge（裸 CDP）vs FishBrowser（koishi-plugin-puppeteer）。
// 本地起一个 127.0.0.1 回显页，两边各导航一次，收集请求头 + navigator/窗口属性。
// 用法: node scripts/fingerprint.mjs
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)
const BROWSER_UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 本地回显页 ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/collect.js') {
    res.setHeader('content-type', 'application/javascript')
    res.end('')
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><script>
window.__headers = ${JSON.stringify(null)}
</script></head><body>echo</body></html>`)
})
// 回显 headers 的 JSON 端点
const headerLog = []
const echo = http.createServer((req, res) => {
  headerLog.push({ url: req.url, headers: req.headers })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ headers: req.headers }))
})
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port
const echoUrl = `http://127.0.0.1:${echoPort}/echo`

// JS 侧要采的属性
const COLLECT = `(() => {
  const n = navigator;
  const pick = {};
  pick.userAgent = n.userAgent;
  pick.webdriver = n.webdriver;
  pick.language = n.language;
  pick.languages = n.languages;
  pick.platform = n.platform;
  try { pick.userAgentData = { brands: n.userAgentData && n.userAgentData.brands, mobile: n.userAgentData && n.userAgentData.mobile, platform: n.userAgentData && n.userAgentData.platform }; } catch (e) { pick.userAgentData = null; }
  pick.innerWidth = innerWidth; pick.innerHeight = innerHeight;
  pick.outerWidth = outerWidth; pick.outerHeight = outerHeight;
  pick.devicePixelRatio = devicePixelRatio;
  pick.screenWidth = screen.width; pick.screenHeight = screen.height;
  try { pick.intlLocale = Intl.DateTimeFormat().resolvedOptions().locale; } catch (e) { pick.intlLocale = null; }
  return JSON.stringify(pick);
})()`

const HEADERS_WANTED = ['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user']

async function collectViaCdp(send, url) {
  const before = headerLog.length
  await send('Page.navigate', { url })
  await sleep(1500)
  const result = await send('Runtime.evaluate', { expression: COLLECT, returnByValue: true })
  const js = JSON.parse(String(result?.result?.value ?? '{}'))
  const reqs = headerLog.slice(before).filter((r) => r.url === '/echo')
  const headers = reqs.length ? reqs[reqs.length - 1].headers : {}
  const filtered = {}
  for (const k of HEADERS_WANTED) filtered[k] = headers[k] ?? null
  return { headers: filtered, js }
}

// ── 原版：裸 spawn Edge + 裸 CDP（完全按 startBrowser 的参数）──────────────
async function originalSide() {
  const CANDIDATES = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]
  const exe = CANDIDATES.find((p) => fs.existsSync(p))
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-orig-'))
  try { fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true }) } catch {}
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-blink-features=AutomationControlled', '--disable-features=Translate,MediaRouter',
    '--lang=zh-CN', `--user-agent=${BROWSER_UA_CHROME}`,
    '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'
  ]
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  let raw = ''
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && !raw) {
    try {
      if (fs.existsSync(portFile)) {
        const text = fs.readFileSync(portFile, 'utf8').trim()
        if (text) raw = text
      }
    } catch {}
    if (!raw) await sleep(120)
  }
  const port = Number(String(raw).split(/\r?\n/)[0])
  let target = null
  const d2 = Date.now() + 20000
  while (Date.now() < d2 && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
      target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {}
    if (!target) await sleep(150)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 20000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
  })
  ws.addEventListener('message', (event) => {
    let msg
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
    if (!msg?.id) return
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message || 'CDP 错误'))
    else entry.resolve(msg.result)
  })
  await opened
  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 25000)
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  await send('Page.enable')
  const out = await collectViaCdp(send, echoUrl)
  out.executable = exe
  try { ws.close() } catch {}
  const { spawnSync } = await import('node:child_process')
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  return out
}

// ── 移植版：Koishi App + koishi-plugin-puppeteer + FishBrowser ─────────────
async function portSide() {
  const { App } = require('koishi')
  const httpMod = require('@cordisjs/plugin-http')
  const puppeteerMod = require('koishi-plugin-puppeteer')
  const puppeteer = puppeteerMod.default ?? puppeteerMod
  const { FishBrowser } = require('../lib/browser.js')
  const app = new App()
  app.plugin(httpMod.default ?? httpMod)
  app.plugin(puppeteer)
  await app.start()
  const executable = app.puppeteer?.browser ? (app.puppeteer.executable ?? '') : ''
  const browser = new FishBrowser(app, {})
  const out = await browser.run(async (tab) => {
    return collectViaCdp(tab.send, echoUrl)
  })
  out.executable = executable
  await browser.dispose()
  await app.stop()
  return out
}

const orig = await originalSide()
const port = await portSide()
echo.close()
server.close()

fs.mkdirSync(path.join(ROOT, 'test/local/runs'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'test/local/runs/fingerprint.json'), JSON.stringify({ original: orig, port }, null, 2))

const rows = []
const push = (name, a, b) => rows.push({ item: name, original: a ?? '—', port: b ?? '—', match: JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? 'OK' : 'DIFF' })
push('executable', orig.executable, port.executable)
for (const k of HEADERS_WANTED) push(`header ${k}`, orig.headers[k], port.headers[k])
for (const k of Object.keys(orig.js)) push(`js ${k}`, JSON.stringify(orig.js[k]), JSON.stringify(port.js[k]))
const w = Math.max(...rows.map((r) => r.item.length))
for (const r of rows) {
  console.log(`${r.item.padEnd(w + 2)} ${r.match.padEnd(5)} orig=${JSON.stringify(r.original)}  port=${JSON.stringify(r.port)}`)
}
