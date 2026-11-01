// B1: 用和原版一模一样的请求抓三个直连引擎的原始响应，存为差分测试的本地 fixture。
// 用法: node scripts/capture.mjs <image-file>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'test/local/fixtures/parsers')
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

const imagePath = process.argv[2]
if (!imagePath) { console.error('usage: node scripts/capture.mjs <image-file>'); process.exit(2) }
const bytes = fs.readFileSync(imagePath)

function sniffMime(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  return 'image/jpeg'
}
const mimeType = sniffMime(bytes)
const filename = 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png')
console.log(`image: ${imagePath} (${bytes.length} bytes, ${mimeType})`)

const timeoutMs = 45000
const stem = path.basename(imagePath).replace(/\.[^.]+$/, '') || 'sample-1'

async function saucenao() {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), filename)
  form.append('db', '999')
  form.append('output_type', '0')
  const res = await fetch('https://saucenao.com/search.php', {
    method: 'POST', body: form, redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const body = await res.text()
  fs.mkdirSync(path.join(OUT, 'saucenao'), { recursive: true })
  fs.writeFileSync(path.join(OUT, 'saucenao', `${stem}.html`), body)
  console.log(`saucenao: HTTP ${res.status}, ${body.length} bytes`)
  return res.status
}

async function iqdb() {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), filename)
  for (const n of [1, 2, 3, 4, 5, 6]) form.append('service[]', String(n))
  const res = await fetch('https://iqdb.org/', {
    method: 'POST', body: form, redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(Math.max(timeoutMs, 35000))
  })
  const body = await res.text()
  fs.mkdirSync(path.join(OUT, 'iqdb'), { recursive: true })
  fs.writeFileSync(path.join(OUT, 'iqdb', `${stem}.html`), body)
  console.log(`iqdb: HTTP ${res.status}, ${body.length} bytes`)
  return res.status
}

async function tracemoe() {
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: mimeType }), filename)
  const res = await fetch('https://api.trace.moe/search?anilistInfo', {
    method: 'POST', body: form,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const body = await res.text()
  fs.mkdirSync(path.join(OUT, 'tracemoe'), { recursive: true })
  fs.writeFileSync(path.join(OUT, 'tracemoe', `${stem}.json`), body)
  console.log(`tracemoe: HTTP ${res.status}, ${body.length} bytes`)
  return res.status
}

for (const [name, fn] of [['saucenao', saucenao], ['iqdb', iqdb], ['tracemoe', tracemoe]]) {
  try {
    const status = await fn()
    if (status === 403 && name === 'saucenao') {
      console.log('saucenao 403, wait 60s and retry once')
      await new Promise((r) => setTimeout(r, 60000))
      await fn()
    }
  } catch (error) {
    console.log(`${name} FAILED: ${error?.message ?? error}`)
  }
}
console.log('done')
