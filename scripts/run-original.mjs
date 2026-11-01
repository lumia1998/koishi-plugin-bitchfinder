// B3: 用原版（test/local/original 副本）对一张图做完整反查，和 adapters/onebot.mjs 走同一套调用。
// 用法: node scripts/run-original.mjs <image> <tag>
// 产出: test/local/runs/original-<tag>.json + test/local/fixtures/candidates/original-<tag>.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ORIG_DIR = path.join(ROOT, 'test/local/original')

const imagePath = process.argv[2]
const tag = process.argv[3] || '1'
if (!imagePath) { console.error('usage: node scripts/run-original.mjs <image> <tag>'); process.exit(2) }

const mod = await import(pathToFileURL(path.join(ORIG_DIR, 'src/fish-find-chicken.js')).href)
const { reverseSearch, extractAccounts, formatReply, closeBrowser } = mod

function sniffMime(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}

const bytes = fs.readFileSync(imagePath)
const mimeType = sniffMime(bytes)
const log = []
const started = Date.now()
let result
try {
  result = await reverseSearch(bytes, mimeType, {
    engines: ['lens', 'saucenao', 'tracemoe'],
    timeoutMs: 45000,
    proxy: '',
    browserExe: '',
    onLog: (line) => { log.push(line); console.log('  ' + line) }
  })
} finally {
  await closeBrowser()
}
const elapsedMs = Date.now() - started
const accounts = extractAccounts(result.candidates, { max: 3, strictNames: true })
const text = formatReply({
  accounts,
  candidates: result.candidates,
  enginesUsed: result.enginesUsed,
  failures: result.failures
})

const runDir = path.join(ROOT, 'test/local/runs')
const candDir = path.join(ROOT, 'test/local/fixtures/candidates')
fs.mkdirSync(runDir, { recursive: true })
fs.mkdirSync(candDir, { recursive: true })
fs.writeFileSync(path.join(runDir, `original-${tag}.json`), JSON.stringify({
  elapsedMs, enginesUsed: result.enginesUsed, failures: result.failures,
  candidates: result.candidates, accounts, text, log
}, null, 2))
fs.writeFileSync(path.join(candDir, `original-${tag}.json`), JSON.stringify({ candidates: result.candidates }, null, 2))
console.log(`\n=== text ===\n${text}\n`)
console.log(`elapsed ${(elapsedMs / 1000).toFixed(1)}s · engines ${result.enginesUsed.join(', ') || '无'} · failures ${JSON.stringify(result.failures)}`)
