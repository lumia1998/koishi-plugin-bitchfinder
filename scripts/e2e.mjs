// B3: Koishi App + puppeteer + mock + 本插件 的端到端。
// 用法: node scripts/e2e.mjs <image> [--steps=a,b,c,d,e]
//   a) userA 同条消息带图发「找鸡」（期望两条回复：收到 + 结果）
//   b) userA 立刻再发（期望「刚查过」）
//   c) userB 裸发「找鸡」（期望「要引用有图的那条」）
//   d) 引用路径：<quote> 里带图（冷却过后再发；新进程则跳过等待）
//   e) ChatLuna 工具 findbitch 直接 invoke
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const imagePath = process.argv[2]
if (!imagePath) { console.error('usage: node scripts/e2e.mjs <image> [--steps=a,b,c,d,e]'); process.exit(2) }
const stepsArg = process.argv.find((a) => a.startsWith('--steps='))
const steps = new Set((stepsArg ? stepsArg.slice(8) : 'a,b,c,d,e').split(','))

const { App } = require('koishi')
const httpMod = require('@cordisjs/plugin-http')
const puppeteerMod = require('koishi-plugin-puppeteer')
const mockMod = require('@koishijs/plugin-mock')
const bitPlugin = require('../lib/index.js')
const engines = require('../lib/engines.js')
const accounts = require('../lib/accounts.js')
const { FishBrowser } = require('../lib/browser.js')
const { createFindBitchTool } = require('../lib/tool.js')

const bytes = fs.readFileSync(imagePath)
const b64 = bytes.toString('base64')
const imgEl = `<img src="base64://${b64}"/>`

const SETTINGS = {
  engines: ['lens', 'saucenao', 'tracemoe'],
  timeoutMs: 45000,
  maxAccounts: 3,
  strictConsensus: true,
  cooldownSec: 30
}

// 记录每次 reverseSearch 的原始结果（同模块引用，插件内部会走到这个包装）
let lastSearch = null
const origReverseSearch = engines.reverseSearch
engines.reverseSearch = async (...args) => {
  const r = await origReverseSearch(...args)
  lastSearch = { result: r, at: Date.now() }
  return r
}

// lens-ablation 消融出来的最小可行配置：只加这一条启动参数，Lens 3/3 通过；
// 默认配置 3/3 全被谷歌验证码拦。Edge 二进制 / 持久 profile / 去 --enable-automation 均非必要。
const puppeteerConfig = {
  args: ['--disable-blink-features=AutomationControlled']
}

const app = new App()
app.plugin(httpMod.default ?? httpMod)
app.plugin(puppeteerMod.default ?? puppeteerMod, puppeteerConfig)
app.plugin(mockMod.default ?? mockMod)
app.plugin(bitPlugin, { ...SETTINGS, proxy: '', foundImage: '', registerTool: true })
await app.start()

const clientA = app.mock.client('alice', 'chan-1')
const clientB = app.mock.client('bob', 'chan-1')

// 所有 bot 消息按序带时间戳
const sentLog = []
for (const [who, client] of [['alice', clientA], ['bob', clientB]]) {
  const origFlush = client.flush.bind(client)
  client.flush = (buf) => {
    if (buf) sentLog.push({ t: Date.now(), client: who, text: buf })
    origFlush(buf)
  }
}

const runDir = path.join(ROOT, 'test/local/runs')
const candDir = path.join(ROOT, 'test/local/fixtures/candidates')
fs.mkdirSync(runDir, { recursive: true })
fs.mkdirSync(candDir, { recursive: true })

const savePortRun = (tag, replies, started) => {
  const s = lastSearch?.result
  if (!s) { console.log(`  !! port-${tag}: 没抓到 reverseSearch 结果`); return }
  fs.writeFileSync(path.join(runDir, `port-${tag}.json`), JSON.stringify({
    elapsedMs: Date.now() - started,
    enginesUsed: s.enginesUsed, failures: s.failures,
    candidates: s.candidates,
    accounts: null, text: replies?.[replies.length - 1] ?? '', log: []
  }, null, 2))
  fs.writeFileSync(path.join(candDir, `port-${tag}.json`), JSON.stringify({ candidates: s.candidates }, null, 2))
}

try {
  if (steps.has('a')) {
    console.log('--- (a) userA 带图发「找鸡」（+ (b) 并发：一次搜索比 30s 冷却还久，得在搜索进行中发第二条才能测到）')
    const t0 = Date.now()
    lastSearch = null
    const pA = clientA.receive(`找鸡 ${imgEl}`)
    let pB = null
    if (steps.has('b')) {
      await sleep(300)
      console.log('--- (b) userA 在 (a) 进行中立刻再发')
      pB = clientA.receive(`找鸡 ${imgEl}`)
    }
    const replies = await pA
    console.log('  (a) replies:', JSON.stringify(replies))
    console.log(`  [check] 消息条数 = ${replies.length}（期望 2：收到 + 结果）`)
    if (replies.some((r) => r.includes('**'))) console.log('  [check] !! 结果里还残留 **')
    if (replies.some((r) => /^\d+$/.test(r) || /^\[.+\]$/.test(r))) console.log('  [check] !! 疑似把 message id 当消息发出去了')
    savePortRun('a', replies, t0)
    if (pB) {
      const repliesB = await pB
      console.log('  (b) replies:', JSON.stringify(repliesB))
      const hit = repliesB.some((r) => r.startsWith('刚查过')) || sentLog.some((m) => m.text.startsWith('刚查过'))
      console.log(`  [check] 期望「刚查过」: ${hit ? 'OK' : 'MISS'}`)
    }
  }

  if (steps.has('c')) {
    console.log('--- (c) userB 裸发「找鸡」')
    const replies = await clientB.receive('找鸡')
    console.log('  replies:', JSON.stringify(replies))
    console.log(`  [check] 期望「要引用有图的那条」: ${replies.some((r) => r.includes('要引用有图')) ? 'OK' : 'MISS'}`)
  }

  if (steps.has('d')) {
    console.log('--- (d) userA 引用带图消息发「找鸡」')
    const t0 = Date.now()
    lastSearch = null
    const replies = await clientA.receive(`<quote id="q99">${imgEl}</quote>找鸡`)
    console.log('  replies:', JSON.stringify(replies).slice(0, 600))
    savePortRun('d', replies, t0)
  }

  if (steps.has('e')) {
    console.log('--- (e) findbitch 工具直接 invoke')
    const browser = new FishBrowser(app, {})
    const findChicken = async (image) => {
      const result = await origReverseSearch(image.bytes, image.mimeType, {
        engines: SETTINGS.engines, timeoutMs: SETTINGS.timeoutMs, browser,
        onLog: (line) => console.log('  ' + line)
      })
      const found = accounts.extractAccounts(result.candidates, { max: SETTINGS.maxAccounts, strictNames: SETTINGS.strictConsensus })
      const text = accounts.formatReply({
        accounts: found, candidates: result.candidates,
        enginesUsed: result.enginesUsed, failures: result.failures
      }).replace(/\*\*/g, '')
      return { text, accounts: found }
    }
    const tool = createFindBitchTool(app, {
      logger: app.logger('bitchfinder'),
      findChicken,
      lastUse: new Map(),
      gap: SETTINGS.cooldownSec * 1000,
      keyOf: (s) => `${s.platform}:${s.channelId}|${s.userId}`
    })
    const t0 = Date.now()
    lastSearch = null
    const out = await tool.invoke({ image_url: `data:image/png;base64,${b64}` })
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    console.log('  tool output:', text.slice(0, 800))
    savePortRun('e', [text], t0)
    await browser.dispose()
  }
} finally {
  fs.writeFileSync(path.join(runDir, 'e2e-messages.json'), JSON.stringify(sentLog, null, 2))
  console.log('\n=== sentLog ===')
  for (const m of sentLog) console.log(`  [${new Date(m.t).toISOString()}] ${m.client}: ${m.text.slice(0, 120).replace(/\n/g, '⏎')}`)
  try { await app.stop() } catch {}
}
