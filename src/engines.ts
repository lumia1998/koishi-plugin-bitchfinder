// 鱼鱼找鸡：被引图片 → 反查来源 → 抽 coser 社媒账号 → 回一句话。
//
// 设计要点（都是踩过才知道的）：
//   · 引擎能力差别极大：SauceNAO 是唯一「无 key、纯 HTTP、直连可达」的，其余
//     直连接口全是空壳或被拒，必须真浏览器跑 DOM。
//   · 浏览器一次只跑一个任务（FishBrowser 里有全局 FIFO 锁）。
//   · 出站请求一律走 safeFetch（防 SSRF）或白名单里的固定 POST。绝不把用户图片
//     发到白名单外的域名。
//   · 这个模块零 token：不碰任何大模型。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateFetchUrl } from './safe-fetch'
import { matchPlatform, socialNameFromTitle } from './accounts'
import type { Candidate, Failure } from './accounts'
import { absUrl, hostOf, sleep, stripTags, trimText } from './utils'
import { BROWSER_UA } from './constants'
import { fileUploadHtml, resolveLensGoto, visit } from './browser'
import type { BrowserTab, FishBrowser } from './browser'

export { UPLOAD_HOSTS, hostAllowed, BROWSER_UA, BROWSER_UA_CHROME } from './constants'

export const ENGINE_IDS = ['saucenao', 'lens', 'baidu', 'iqdb', 'tracemoe'] as const
export type EngineId = typeof ENGINE_IDS[number]

// ── Google Lens ───────────────────────────────────────────────────────────
// 移植自 koishi-plugin-imgsearch-coser（WhiteBr1ck）的核心思路：找 coser 最准的一条路是
// Google Lens 反查图片，结果里往往直接是原帖（x.com/xxx/status/…）。
// 它没有公开 JSON 接口，只有 lens.google.com/v3/upload 这个「POST 图片 → 302 到结果页」的网页接口。
// fetch 会踩 CORS，所以这里用真浏览器在页面里造一个 form 去 POST：浏览器天然走系统代理（魔法在线时
// 才通），也天然带着谷歌自己的 cookie。
export const LENS_EXTRACT = `(() => {
  const isGoogle = (host) => /(^|\\.)google\\.[a-z.]+$/i.test(host);
  const isAsset = (host) => /(^|\\.)(gstatic|googleusercontent)\\.com$/i.test(host);
  const cleanTitle = (node) => {
    const heading = node.querySelector('h1,h2,h3,[role=heading]');
    const text = String(
      (heading && heading.textContent) ||
      node.getAttribute('aria-label') ||
      node.textContent || ''
    ).replace(/\\s+/g, ' ').trim();
    return text.slice(0, 200);
  };
  const rows = [];
  const cards = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, footer, nav, [role=navigation]')) continue;
    const raw = a.getAttribute('href') || '';
    let u;
    try { u = new URL(raw, location.href); } catch (e) { continue; }
    if (u.protocol !== 'https:') continue;
    const title = cleanTitle(a);
    if (!title) continue;
    // 谷歌视觉搜索的结果卡片全是 /goto?url=<不透明 token>：真实域名只有浏览器自己知道，
    // 交给外面用 CDP 请求拦截去解（页面里 fetch 会吃 CORS）。
    if (isGoogle(u.hostname) && u.pathname === '/goto' && u.searchParams.get('url')) {
      if (cards.length < 24) cards.push({ wrapper: u.href, title });
      continue;
    }
    if (isGoogle(u.hostname) || isAsset(u.hostname)) {
      const wrapped = u.searchParams.get('url') || u.searchParams.get('q') || '';
      if (!/^https?:\\/\\//.test(wrapped) || seen.has(wrapped)) continue;
      seen.add(wrapped);
      rows.push({ url: wrapped, title });
      continue;
    }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    rows.push({ url: u.href, title });
  }
  const bodyText = document.body ? document.body.innerText.slice(0, 4000) : '';
  return JSON.stringify({
    url: location.href,
    count: rows.length,
    cards: cards,
    results: rows,
    captcha: /unusual traffic|our systems have detected/i.test(bodyText) || /\\/sorry\\//.test(location.href),
    empty: /No matches|No results|找不到相符|没有找到|未找到/i.test(bodyText)
  });
})()`

// 只有这几类卡片值得多花时间解域名：真人 coser 的号基本只在社交平台上。
export const LENS_SOCIAL_RE = /^(x|twitter|推特|instagram|ig|ins|微博|weibo|bilibili|哔哩|tiktok|抖音|facebook|fb|threads|xiaohongshu|小红书)/i
// 已经解出真实域名时用它判断「这条是不是社交站点」，比看标题更可靠
export const LENS_SOCIAL_HOST_RE = /^https?:\/\/(?:www\.|m\.)?(?:x|twitter|instagram|weibo|bilibili|tiktok|facebook|threads|xiaohongshu)\.(?:com|net)\//i

// ── Google Lens（SerpApi 通道）─────────────────────────────────────────────
// SerpApi 是谷歌结果的官方第三方 API（付费，免费档 100 次/月）。它只吃「公网可
// 访问的图片 URL」——SerpApi 的抓取器自己去拉图，所以 base64/本地图用不了这条。
// type=exact_matches 对应浏览器 Lens 的 udm=48 完全匹配；空结果时再要一份视觉匹配。
export async function serpapiLensSearch(imageUrl: string, { apiKey, timeoutMs = 45000 }: { apiKey: string; timeoutMs?: number }): Promise<Candidate[]> {
  const key = String(apiKey ?? '').trim()
  if (!key) throw new Error('Google Lens(SerpApi) 需要 serpapiKey')
  const fetchKind = async (type: string) => {
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google_lens')
    if (type) url.searchParams.set('type', type)
    url.searchParams.set('url', imageUrl)
    url.searchParams.set('safe', 'off')
    url.searchParams.set('hl', 'zh-CN')
    url.searchParams.set('api_key', key)
    await validateFetchUrl(url.href)
    const response = await fetch(url.href, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(timeoutMs, 15000))
    })
    if (!response.ok) throw new Error(`Google Lens(SerpApi) HTTP ${response.status}（key 无效或额度耗尽）`)
    const data: any = await response.json()
    if (data?.error) throw new Error(`Google Lens(SerpApi)：${String(data.error).slice(0, 120)}`)
    return data
  }
  const seen = new Set<string>()
  const rows: Candidate[] = []
  const collect = (items: any[]) => {
    for (const item of items ?? []) {
      const link = String(item?.link ?? '')
      const source = item?.source
      const page = String(typeof source === 'object' && source ? source.link || link : link)
      if (!/^https?:\/\//.test(page) || seen.has(page)) continue
      seen.add(page)
      rows.push({
        url: page,
        title: String((typeof source === 'object' && source ? source.name : '') || item?.title || '').slice(0, 200),
        similarity: null,
        sourceUrl: page
      })
    }
  }
  const exact = await fetchKind('exact_matches')
  collect(exact?.exact_matches)
  if (!rows.length) {
    const visual = await fetchKind('')
    collect(visual?.visual_matches)
    collect(visual?.exact_matches)
  }
  return rows.slice(0, 24)
}

interface LensOptions {
  hl?: string
  timeoutMs?: number
  tempDir?: string
  exactPass?: boolean
}

export async function googleLensSearch(browser: FishBrowser, bytes: Buffer, mimeType: string, { hl = 'zh-CN', timeoutMs = 45000, tempDir, exactPass = true }: LensOptions = {}): Promise<Candidate[]> {
  if (!bytes || !bytes.length) throw new Error('没有图片')
  const dir = tempDir || os.tmpdir()
  const ext = /png/i.test(String(mimeType ?? '')) ? 'png' : 'jpg'
  const file = path.join(dir, `fish-lens-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`)
  fs.writeFileSync(file, bytes)
  const prepare = [
    '(function () {',
    "  if (document.getElementById('fishLensForm')) return 'exists';",
    "  var form = document.createElement('form');",
    "  form.id = 'fishLensForm'; form.method = 'POST'; form.enctype = 'multipart/form-data';",
    "  form.action = 'https://lens.google.com/v3/upload?hl=" + hl + "';",
    "  form.target = '_self'; form.style.display = 'none';",
    "  var picker = document.createElement('input');",
    "  picker.type = 'file'; picker.name = 'encoded_image'; picker.id = 'fishLensFile';",
    '  form.appendChild(picker);',
    "  var marker = document.createElement('input');",
    "  marker.type = 'hidden'; marker.name = 'image_content'; marker.value = '';",
    '  form.appendChild(marker);',
    '  document.body.appendChild(form);',
    "  return 'ok';",
    '})()'
  ].join('\n')
  try {
    return await browser.run(async (tab) => {
      const out = await fileUploadHtml(tab, {
        startUrl: 'https://www.google.com/',
        filePath: file,
        fileSelector: '#fishLensFile',
        prepareExpression: prepare,
        submitExpression: "document.getElementById('fishLensForm').submit()",
        // 跳转到结果页之后还有一段 JS 渲染：只看 URL 会抓到一张空壳，必须等结果卡片真落地
        waitForExpression: 'document.body && document.body.innerText.length > 400 && document.querySelectorAll("a[href]").length > 25',
        extractExpression: LENS_EXTRACT,
        settleMs: 2500,
        timeoutMs: Math.max(timeoutMs, 30000)
      })
      let page = out?.data
      if (typeof page === 'string') {
        try { page = JSON.parse(page) } catch { page = {} }
      }
      page = page && typeof page === 'object' ? page : {}
      if (page.captcha) throw new Error('GOOGLE_CAPTCHA：谷歌要求验证，稍后再试')
      // 一页结果分两段解析：先拿结果卡片，再逐条解出 /goto?url= 背后的真实域名。
      const collectFrom = async (parsed: any) => {
        const out2 = { rows: Array.isArray(parsed?.results) ? parsed.results.slice() : [], cards: Array.isArray(parsed?.cards) ? parsed.cards : [] }
        if (!out2.cards.length) return out2.rows
        // 社交卡片优先解：它们最可能就是原帖/作者；解够 6 条就停，别把时间花在文章页上
        const social = out2.cards.filter((card: any) => LENS_SOCIAL_RE.test(String(card.title ?? '')))
        const queue = social.concat(out2.cards.filter((card: any) => !LENS_SOCIAL_RE.test(String(card.title ?? '')))).slice(0, 6)
        for (const card of queue) {
          const target = await resolveLensGoto(tab, String(card.wrapper ?? ''), { timeoutMs: 12000 })
          if (!target) continue
          if (out2.rows.some((row: any) => String(row?.url ?? '') === target)) continue
          const cardTitle = String(card.title ?? '').slice(0, 200)
          out2.rows.push({ url: target, title: cardTitle, authorName: socialNameFromTitle(cardTitle) })
        }
        return out2.rows
      }
      const visualRows = await collectFrom(page)
      const looksSocial = (list: any[]) => list.some((row) => LENS_SOCIAL_RE.test(String(row?.title ?? '')) || LENS_SOCIAL_HOST_RE.test(String(row?.url ?? '')))
      // 「完全匹配」= 同一张图在网上的原出处，通常直接就是原帖；外观相似则只是长得像。
      // 外观那页已经捞到社交账号就不再跑第二趟（省 5 秒），否则补一趟。
      let exactRows: any[] = []
      if (exactPass !== false && !looksSocial(visualRows)) {
        const exactUrl = (() => {
          try {
            const u = new URL(String(out?.url ?? ''))
            if (!/^https:\/\/www\.google\.[a-z.]+\/search/i.test(u.href)) return ''
            u.searchParams.set('udm', '48')
            return u.href
          } catch { return '' }
        })()
        if (exactUrl) {
          try {
            const visited = await visit(tab, {
              url: exactUrl,
              waitForExpression: 'document.body && document.querySelectorAll("a[href]").length > 20',
              extractExpression: LENS_EXTRACT,
              settleMs: 2200,
              timeoutMs: Math.max(timeoutMs, 30000)
            })
            let exactPage = visited?.data
            if (typeof exactPage === 'string') {
              try { exactPage = JSON.parse(exactPage) } catch { exactPage = {} }
            }
            if (exactPage && !exactPage.captcha) {
              exactRows = (await collectFrom(exactPage)).map((row: any) => ({ ...row, exact: true }))
            }
          } catch { /* 完全匹配这趟失败不影响主结果，视觉结果已经在手上 */ }
        }
      }
      const rows = exactRows.concat(visualRows)
      return rows
        .filter((row) => row && typeof row.url === 'string')
        .map((row) => ({ url: row.url, title: String(row.title ?? '').slice(0, 200), similarity: null, sourceUrl: row.url }))
    })
  } catch (error) {
    const message = String((error as Error)?.message ?? '')
    if (/ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_PROXY|ERR_TIMED_OUT/i.test(message)) {
      throw new Error('GOOGLE_UNREACHABLE：谷歌连不上（猫猫云没开或系统代理没开）')
    }
    throw error
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

// SauceNAO：multipart POST，无 key 也能出结果；连续调用会被 403 限流。
async function saucenaoSearch(bytes: Buffer, mimeType: string, { timeoutMs, onLog }: { timeoutMs: number; onLog?: (line: string) => void }): Promise<Candidate[]> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'))
  form.append('db', '999')
  form.append('output_type', '0')
  const url = 'https://saucenao.com/search.php'
  await validateFetchUrl(url)
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (response.status === 403) {
    const error = new Error('SauceNAO 限流（403），至少等 60 秒再试') as Error & { code?: string }
    error.code = 'RATE_LIMITED'
    throw error
  }
  if (!response.ok) throw new Error(`SauceNAO HTTP ${response.status}`)
  const html = await response.text()
  return parseSaucenao(html)
}

export function parseSaucenao(html: string): Candidate[] {
  const text = String(html ?? '')
  const blocks = text.split(/<div class="result\b/).slice(1)
  if (!blocks.length) {
    // 有些版本用 <div id="res<index>" class="result">，退一步按 similarity 直接抓
    const fallback: Candidate[] = []
    const re = /resultsimilarityinfo[^>]*>\s*([\d.]+)%/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) fallback.push({ similarity: Number(m[1]) / 100 })
    return fallback
  }
  const candidates: Candidate[] = []
  for (const block of blocks) {
    const simMatch = block.match(/resultsimilarityinfo[^>]*>\s*([\d.]+)%/)
      || block.match(/similarity-info[^>]*>[\s\S]{0,120}?([\d.]+)%/)
      || block.match(/([\d.]+)%/)
    const similarity = simMatch ? Number(simMatch[1]) / 100 : null

    const titleMatch = block.match(/class="resulttitle"[\s\S]{0,400}?<strong[^>]*>([\s\S]*?)<\/strong>/i)
      || block.match(/class="resulttitle"[\s\S]{0,200}?>\s*([^<]{2,200})</i)
    const title = titleMatch ? stripTags(titleMatch[1]) : ''

    // 结果里所有外链：第一个一般就是图源
    const links: string[] = []
    const hrefRe = /href="([^"]+)"/g
    let hm: RegExpExecArray | null
    while ((hm = hrefRe.exec(block))) {
      const href = absUrl(hm[1], 'https://saucenao.com/')
      if (!href) continue
      const host = hostOf(href)
      if (!host || host.endsWith('saucenao.com')) continue
      if (!links.includes(href)) links.push(href)
    }

    // 作者行：SauceNAO 实际写的是 `Member: <a href=...>作者名</a>`（pixiv 老格式 member.php?id=），
    // 也有 `Author:` 的写法 —— 两种都认，抓错了顶多是空，不会误认。
    const authorMatch = block.match(/(?:Member|Author)[\s\S]{0,240}?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/author[^>]*>[\s\S]{0,200}?href="([^"]+)"/i)
    const authorUrl = authorMatch ? absUrl(authorMatch[1], 'https://saucenao.com/') : ''
    // 作者名（如 `豊栄@ﾄﾞﾔｧ…`）：拿它去搜推特比拿作品标题搜准得多。
    const authorName = authorMatch && authorMatch[2] ? trimText(stripTags(authorMatch[2]), 40) : ''

    const snippet = trimText(stripTags(block), 200)
    if (!links.length && !title) continue
    candidates.push({
      engine: 'saucenao',
      similarity,
      title,
      sourceUrl: links[0] ?? '',
      authorUrl,
      authorName,
      host: hostOf(links[0] ?? authorUrl),
      snippet,
      links
    })
  }
  return candidates
}

// ── IQDB：multipart POST，动漫图库（danbooru / konachan / yande.re）─────────
export function parseIqdb(html: string): Candidate[] {
  const text = String(html ?? '')
  if (/Place in queue|under high load/i.test(text)) {
    const error = new Error('IQDB 在排队（站点高负载），过一会儿再试') as Error & { code?: string }
    error.code = 'QUEUED'
    throw error
  }
  if (/No relevant matches/i.test(text)) return []
  const links: { url: string; host: string; title: string }[] = []
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = absUrl(String(m[1]).replace(/^\/\//, 'https://'), 'https://iqdb.org/')
    if (!url) continue
    const host = hostOf(url)
    if (!host || host.endsWith('iqdb.org')) continue
    if (/\.(?:css|js|ico|png|jpe?g|gif|svg)(?:\?|$)/i.test(url)) continue
    if (links.some((item) => item.url === url)) continue
    links.push({ url, host, title: trimText(stripTags(m[2]), 100) })
  }
  const sim = text.match(/(\d{1,3})%\s*similarity/i)
  const similarity = sim ? Number(sim[1]) / 100 : null
  return links.slice(0, 12).map((item) => ({
    engine: 'iqdb',
    similarity,
    title: item.title,
    sourceUrl: item.url,
    authorUrl: '',
    host: item.host,
    snippet: '',
    links: [item.url]
  }))
}

async function iqdbSearch(bytes: Buffer, mimeType: string, { timeoutMs, onLog }: { timeoutMs: number; onLog?: (line: string) => void }): Promise<Candidate[]> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'))
  for (const n of [1, 2, 3, 4, 5, 6]) form.append('service[]', String(n))
  const url = 'https://iqdb.org/'
  await validateFetchUrl(url)
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(Math.max(timeoutMs, 35000))
  })
  if (!response.ok) throw new Error(`IQDB HTTP ${response.status}`)
  return parseIqdb(await response.text())
}

// ── trace.moe：动画截图反查（给的是番剧/集数，不是社媒账号）────────────────
export function parseTracemoe(payload: any): Candidate[] {
  const list = Array.isArray(payload?.result) ? payload.result : []
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const item of list.slice(0, 10)) {
    // 0.87 以下基本是「随便一个番的某帧」，真命中一般 0.9 以上 —— 低于门槛的宁可不要，
    // 否则每次都会往结果里塞十条无关番剧。
    const similarity = Number.isFinite(item?.similarity) ? item.similarity : 0
    if (similarity < 0.87) continue
    const anilistId = item?.anilist?.id ?? item?.anilist?.anime_id ?? null
    const title = item?.anilist?.title?.native || item?.anilist?.title?.romaji || item?.anilist?.title?.english || item?.filename || ''
    const sourceUrl = anilistId ? `https://anilist.co/anime/${anilistId}` : ''
    if (!sourceUrl || seen.has(sourceUrl)) continue
    seen.add(sourceUrl)
    const episode = Number.isFinite(item?.episode) ? ` 第${item.episode}集` : ''
    out.push({
      engine: 'tracemoe',
      similarity,
      title: trimText(`${title}${episode}`, 120),
      sourceUrl,
      authorUrl: '',
      host: 'anilist.co',
      snippet: trimText(String(item?.filename ?? ''), 120),
      links: [sourceUrl]
    })
    if (out.length >= 3) break
  }
  return out
}

async function tracemoeSearch(bytes: Buffer, mimeType: string, { timeoutMs }: { timeoutMs: number }): Promise<Candidate[]> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mimeType || 'image/png' }), 'image.' + (mimeType === 'image/jpeg' ? 'jpg' : 'png'))
  const url = 'https://api.trace.moe/search?anilistInfo'
  await validateFetchUrl(url)
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`trace.moe HTTP ${response.status}`)
  return parseTracemoe(await response.json())
}

// ── 百度识图（真浏览器上传）：结果是「相似图」，噪声大，只留账号主页形态的链接 ──
export function parseBaiduGraph(html: string): Candidate[] {
  const links = collectExternalLinks(html, {
    base: 'https://graph.baidu.com/',
    excludeHosts: ['baidu.com', 'bdstatic.com', 'baidupcs.com', 'bdimg.com', 'bdurl.net'],
    cap: 60
  })
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const item of links) {
    const hit = matchPlatform(item.url)
    if (!hit) continue // 文章页 / 图集页一律不要，只认账号主页形态
    const url = hit.url || item.url
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      engine: 'baidu',
      similarity: null,
      weak: true, // 相似图不一定同一个人，标记成弱证据
      title: item.title,
      sourceUrl: url,
      authorUrl: '',
      host: hostOf(url),
      snippet: '',
      links: [url]
    })
  }
  return out
}

// 三家浏览器引擎的 DOM 都是「一堆外链卡片」，结构天天变，所以统一退到最稳的做法：
// 抓所有外链、去重、排除引擎自家域名，锚文本能取到就取（取不到不影响账号抽取）。
function collectExternalLinks(html: string, { base, excludeHosts = [], cap = 24 }: { base: string; excludeHosts?: string[]; cap?: number }): { url: string; host: string; title: string }[] {
  const text = String(html ?? '')
  const out: { url: string; host: string; title: string }[] = []
  const seen = new Set<string>()
  const anchorRe = /<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const push = (href: string, label: string) => {
    const url = absUrl(href, base)
    const host = hostOf(url)
    if (!url || !host) return
    if (excludeHosts.some((bad) => host === bad || host.endsWith('.' + bad))) return
    if (seen.has(url)) return
    seen.add(url)
    out.push({
      url,
      host,
      title: label ? trimText(stripTags(label), 120) : ''
    })
  }
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(text))) {
    push(m[1], m[2])
    if (out.length >= cap * 3) break
  }
  // 兜底：还有没被锚点包住的链接（JS 里拼的、property 里的）
  if (out.length < cap) {
    const hrefRe = /href="(https?:\/\/[^"]+)"/gi
    while ((m = hrefRe.exec(text))) {
      push(m[1], '')
      if (out.length >= cap * 3) break
    }
  }
  return out.slice(0, cap)
}

export interface ReverseSearchResult {
  candidates: Candidate[]
  failures: Failure[]
  enginesUsed: string[]
}

/**
 * 反查一张图。引擎选择由调用方从配置读出后传进来。
 * 单个引擎失败不影响其它引擎；全失败返回 failures 说明原因。
 */
export async function reverseSearch(bytes: Buffer, mimeType: string, { engines, timeoutMs = 25000, onLog, browser, tempDir, lensUrl, serpapiKey }: {
  engines?: string[]
  timeoutMs?: number
  onLog?: (line: string) => void
  browser?: FishBrowser
  tempDir?: string
  /** 图片的公网 URL（有它 SerpApi 通道才可用） */
  lensUrl?: string
  /** SerpApi key：填了且 lensUrl 存在时 Lens 走 API，失败回退浏览器 */
  serpapiKey?: string
} = {}): Promise<ReverseSearchResult> {
  const list = (Array.isArray(engines) && engines.length ? engines : ['saucenao'])
    .filter((id) => (ENGINE_IDS as readonly string[]).includes(id))
  const candidates: Candidate[] = []
  const failures: Failure[] = []
  const enginesUsed: string[] = []

  const runEngine = async (engine: string): Promise<Candidate[]> => {
    if (engine === 'saucenao') return saucenaoSearch(bytes, mimeType, { timeoutMs, onLog })
    if (engine === 'iqdb') return iqdbSearch(bytes, mimeType, { timeoutMs, onLog })
    if (engine === 'tracemoe') return tracemoeSearch(bytes, mimeType, { timeoutMs })
    if (engine === 'lens') {
      const key = String(serpapiKey ?? '').trim()
      if (key && lensUrl) {
        try {
          return await serpapiLensSearch(lensUrl, { apiKey: key, timeoutMs: Math.max(timeoutMs, 30000) })
        } catch (error) {
          onLog?.(`[鱼鱼找鸡] lens(SerpApi) 不可用，回退浏览器：${String((error as Error)?.message ?? error)}`)
        }
      }
      return googleLensSearch(browser!, bytes, mimeType, { timeoutMs: Math.max(timeoutMs, 30000), tempDir })
    }
    if (engine === 'baidu') {
      const dir = tempDir || os.tmpdir()
      const file = path.join(dir, `fish-find-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`)
      fs.writeFileSync(file, bytes)
      try {
        const { html } = await browser!.run((tab: BrowserTab) => fileUploadHtml(tab, {
          startUrl: 'https://graph.baidu.com/pcpage/index?tpl_from=pc',
          filePath: file,
          fileSelector: 'input[type=file].general-upload-file',
          settleMs: 2500,
          timeoutMs: Math.max(timeoutMs, 30000),
          waitForExpression: '(() => (document.querySelectorAll(\'a[href^="http"]\').length > 12 && document.body.innerText.length > 600))()'
        }))
        return parseBaiduGraph(html)
      } finally {
        try { fs.rmSync(file, { force: true }) } catch {}
      }
    }
    throw new Error('未实现的引擎')
  }

  const record = async (engine: string, task: () => Promise<Candidate[]>) => {
    const started = Date.now()
    try {
      const found = await task()
      enginesUsed.push(engine)
      if (Array.isArray(found) && found.length) {
        for (const item of found) candidates.push({ ...item, engine })
      } else {
        failures.push({ engine, reason: '空结果' })
      }
      if (onLog) onLog(`[鱼鱼找鸡] ${engine} 完成 ${Date.now() - started}ms，结果 ${Array.isArray(found) ? found.length : 0} 条`)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error)
      failures.push({ engine, reason })
      if (onLog) onLog(`[鱼鱼找鸡] ${engine} 失败 ${Date.now() - started}ms：${reason}`)
    }
  }

  // 纯网络的三个引擎并发跑（互不影响），浏览器那台独占一个 page，必须串行。
  const NETWORK = new Set(['saucenao', 'iqdb', 'tracemoe'])
  const parallel = list.filter((engine) => NETWORK.has(engine))
  const serial = list.filter((engine) => !NETWORK.has(engine))
  await Promise.all(parallel.map((engine) => record(engine, () => runEngine(engine))))
  for (const engine of serial) {
    await record(engine, () => runEngine(engine))
    if (failures.some((item) => item.engine === engine && /RATE_LIMITED|403/i.test(item.reason))) await sleep(1200)
  }
  return { candidates, failures, enginesUsed }
}
