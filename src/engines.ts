/**
 * 多引擎反搜适配层。
 *
 * 每个引擎独立实现，返回统一的 PostCandidate 列表；任何引擎失败
 * （网络、风控、缺 key）都只影响自身，不影响其他引擎。
 */

import { DomUtils, parseDocument } from 'htmlparser2'

import { HttpClient } from './http'
import { compressToMaxBytes, imageFormat } from './preprocess'
import { EngineError, PostCandidate } from './types'

// ---------------------------------------------------------------------------
// Yandex（.com 与 .ru 同一 CBIR 后端，双域名互备）
// ---------------------------------------------------------------------------

const YANDEX_UPLOAD_REQUEST = JSON.stringify({
  blocks: [{ block: 'b-page_type_search-by-image__link' }],
})
const YANDEX_HOSTS = ['yandex.com', 'yandex.ru']

function quoteKeepUrlChars(value: string): string {
  return encodeURIComponent(value).replace(/%3D/g, '=').replace(/%26/g, '&')
}

export async function searchYandex(
  http: HttpClient,
  image: Buffer,
  options: { timeout?: number; proxy?: string; host?: string } = {},
): Promise<{ resultUrl: string; candidates: PostCandidate[] }> {
  const host = options.host || 'yandex.com'
  const hosts = [host, ...YANDEX_HOSTS.filter((h) => h !== host)]
  let lastError: unknown
  for (const h of hosts) {
    try {
      return await searchYandexOn(http, image, h, options)
    } catch (err) {
      lastError = err
    }
  }
  throw new EngineError(`Yandex 双域名均失败: ${String(lastError)}`)
}

async function searchYandexOn(
  http: HttpClient,
  image: Buffer,
  host: string,
  options: { timeout?: number; proxy?: string },
): Promise<{ resultUrl: string; candidates: PostCandidate[] }> {
  const uploadResp = await http.postFile(
    `https://${host}/images/search`,
    'upfile',
    image,
    {
      timeout: options.timeout,
      proxy: options.proxy,
      filename: 'blob',
      contentType: 'image/jpeg',
      query: {
        rpt: 'imageview',
        format: 'json',
        request: YANDEX_UPLOAD_REQUEST,
      },
    },
  )
  if (!uploadResp.ok) throw new EngineError(`HTTP ${uploadResp.status}`)
  const uploadData: any = await uploadResp.json()
  const blocks = uploadData?.blocks || []
  const params = blocks[0]?.params || {}
  const cbirId = params.cbirId
  const originalUrl = params.originalImageUrl || ''
  if (!cbirId) throw new EngineError('上传响应中未找到 cbirId')

  const resultUrl =
    `https://${host}/images/search?rpt=imageview&cbir_page=similar&cbir_id=` +
    quoteKeepUrlChars(`url=${originalUrl}&cbir_id=${cbirId}`)

  const html = await http.getText(resultUrl, {
    timeout: options.timeout,
    proxy: options.proxy,
  })

  // 验证页 ≠ 无结果：HTTP 200 也可能只是验证页，必须区分失败语义
  if (
    !html.includes('cbirSites') &&
    /ShowCaptcha|captcha-redirect|Captcha/i.test(html)
  ) {
    throw new EngineError(`${host} 返回验证页（搜索未交付，非无结果）`)
  }

  return { resultUrl, candidates: parseYandexHtml(html) }
}

export function parseYandexHtml(html: string): PostCandidate[] {
  const txt = html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  const marker = '"cbirSites":{"sites"'
  const i = txt.indexOf(marker)
  if (i === -1) return []
  const j = txt.indexOf('[', i)
  if (j === -1) return []

  let depth = 0
  let end = -1
  for (let k = j; k < txt.length; k++) {
    const c = txt[k]
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        end = k
        break
      }
    }
  }
  if (end === -1) return []

  let rawList: any[]
  try {
    rawList = JSON.parse(txt.slice(j, end + 1))
  } catch {
    return []
  }

  const out: PostCandidate[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    let pageUrl = String(item?.url || '').replace(
      /[?&]utm_medium=organic(&|%26|&amp;)?utm_source=yandexsmartcamera.*$/,
      '',
    )
    pageUrl = pageUrl.replace(/[?&]+$/, '')
    if (!pageUrl || seen.has(pageUrl)) continue
    seen.add(pageUrl)
    const orig = item?.originalImage || {}
    const thumb = item?.thumb || {}
    out.push({
      engine: 'yandex',
      pageUrl,
      title: item?.title || '',
      description: item?.description || '',
      imageUrl: orig?.url || thumb?.url || '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// SauceNAO：官方 API，直接返回作者与原帖 URL（X status / Pixiv artwork）
// ---------------------------------------------------------------------------

/** multipart 上传用的媒体类型与文件名，按实际文件头决定。 */
function uploadMeta(data: Buffer): { mime: string; filename: string } {
  const fmt = imageFormat(data)
  if (fmt === 'png') return { mime: 'image/png', filename: 'image.png' }
  if (fmt === 'webp') return { mime: 'image/webp', filename: 'image.webp' }
  return { mime: 'image/jpeg', filename: 'image.jpg' }
}

export async function searchSaucenao(
  http: HttpClient,
  image: Buffer | string,
  options: { apiKey: string; timeout?: number; proxy?: string },
): Promise<PostCandidate[]> {
  if (!options.apiKey) {
    throw new EngineError('SauceNAO 需要 api_key（saucenao.com 免费注册，100 次/天）')
  }
  // 本地字节直传（multipart file），不依赖任何第三方图床；
  // 传 URL 时走 SauceNAO 的 url 参数（保留给已有外链的场景）。
  let data: any
  if (Buffer.isBuffer(image)) {
    const meta = uploadMeta(image)
    const resp = await http.postFile('https://saucenao.com/search.php', 'file', image, {
      timeout: options.timeout,
      proxy: options.proxy,
      filename: meta.filename,
      contentType: meta.mime,
      extraFields: {
        db: '999',
        output_type: '2',
        numres: '16',
        api_key: options.apiKey,
      },
    })
    const text = await resp.text()
    try {
      data = JSON.parse(text)
    } catch {
      throw new EngineError(`SauceNAO 响应异常(HTTP ${resp.status}): ${text.slice(0, 120)}`)
    }
    // SauceNAO 对无效 key 返回 HTTP 403 + header.message，优先展示原因
    const header = data?.header || {}
    if (header.status !== undefined && Number(header.status) !== 0) {
      throw new EngineError(
        `SauceNAO: ${header.message || `status=${header.status}`}`,
      )
    }
  } else {
    data = await http.getJson('https://saucenao.com/search.php', {
      timeout: options.timeout,
      proxy: options.proxy,
      query: {
        db: 999,
        output_type: 2,
        numres: 16,
        api_key: options.apiKey,
        url: image,
      },
    })
  }

  const status = data?.header?.status
  if (status !== undefined && status !== null && Number(status) !== 0) {
    throw new EngineError(`SauceNAO status=${status}`)
  }

  const out: PostCandidate[] = []
  for (const result of data?.results || []) {
    const d = result?.data || {}
    const extUrls: string[] = d.ext_urls || []
    const handle: string =
      d.twitter_user_handle || d.author_name || d.member_name || ''
    let platform = ''
    let postUrl = ''
    for (const u of extUrls) {
      if (u.includes('twitter.com') || u.includes('x.com')) {
        platform = 'X/Twitter'
        postUrl = u
        break
      }
      if (u.includes('pixiv.net')) {
        platform = 'Pixiv'
        postUrl = u
      }
    }
    if (!platform && extUrls.length) postUrl = extUrls[0]
    out.push({
      engine: 'saucenao',
      pageUrl: postUrl || extUrls[0] || '',
      postUrl,
      title: d.title || '',
      authorHandle: String(handle).replace(/^@+/, ''),
      authorPlatform: platform || (d.pixiv_id ? 'Pixiv' : ''),
      weight: 0.5,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// ascii2d：无官方 API，解析彩色搜索结果页；当前被 CF 拦，支持 cf_clearance
// ---------------------------------------------------------------------------

export async function searchAscii2d(
  http: HttpClient,
  image: Buffer,
  options: { timeout?: number; proxy?: string; cfClearance?: string },
): Promise<PostCandidate[]> {
  const headers: Record<string, string> = {}
  if (options.cfClearance) {
    headers.Cookie = `cf_clearance=${options.cfClearance}`
  }
  const resp = await http.postFile('https://ascii2d.net/search/file', 'file', image, {
    timeout: options.timeout,
    proxy: options.proxy,
    headers,
    filename: 'blob',
    contentType: 'image/jpeg',
  })
  const text = await resp.text()
  if (resp.status === 403 || text.slice(0, 2000).includes('Just a moment')) {
    throw new EngineError(
      'ascii2d 被 Cloudflare 拦截：可在配置中提供有效的 cf_clearance cookie',
    )
  }
  if (!resp.ok) throw new EngineError(`HTTP ${resp.status}`)

  const out: PostCandidate[] = []
  const seen = new Set<string>()
  const blockRe = /<div class="detail-box[^"]*"[^>]*>([\s\S]*?)<\/div>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(text))) {
    const block = m[1]
    const linkMatch = block.match(/href="(https?:\/\/[^"]+)"[^>]*>/)
    if (!linkMatch) continue
    const url = linkMatch[1]
    if (seen.has(url) || url.includes('ascii2d')) continue
    seen.add(url)

    let handle = ''
    let platform = ''
    const um = url.match(/(?:twitter|x)\.com\/@?(\w{2,20})(?:\/status\/(\d+))?/)
    if (um) {
      handle = um[1]
      platform = 'X/Twitter'
    } else {
      const pm = url.match(/pixiv\.net\/(?:artworks\/\d+|users\/(\d+))/)
      if (pm) {
        handle = pm[1] || ''
        platform = 'Pixiv'
      }
    }
    const titleMatch = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/)
    out.push({
      engine: 'ascii2d',
      pageUrl: url,
      postUrl:
        url.includes('/status/') || url.includes('artworks/') ? url : '',
      title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '',
      authorHandle: handle,
      authorPlatform: platform,
      weight: 0.4,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Google Cloud Vision WEB_DETECTION（官方付费）
// ---------------------------------------------------------------------------

export async function searchGcv(
  http: HttpClient,
  image: Buffer,
  options: { apiKey: string; timeout?: number; proxy?: string },
): Promise<PostCandidate[]> {
  if (!options.apiKey) {
    throw new EngineError('GCV 需要 GCP API key（Vision API，webDetection）')
  }
  const body = {
    requests: [
      {
        image: { content: image.toString('base64') },
        features: [{ type: 'WEB_DETECTION', maxResults: 20 }],
      },
    ],
  }
  const data = await http.getJson(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(
      options.apiKey,
    )}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      timeout: options.timeout,
      proxy: options.proxy,
    },
  )

  const wd = data?.responses?.[0]?.webDetection || {}
  const out: PostCandidate[] = []
  const seen = new Set<string>()
  const sections: Array<[string, number]> = [
    ['pagesWithMatchingImages', 0.3],
    ['fullMatchingImages', 0.2],
    ['partialMatchingImages', 0.15],
  ]
  for (const [section, weight] of sections) {
    for (const item of wd[section] || []) {
      const url = item?.url || ''
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push({ engine: 'gcv', pageUrl: url, weight })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// SerpApi Google Lens：exact_matches 完全匹配（官方第三方 API，付费）
// ---------------------------------------------------------------------------

export async function searchGoogleLens(
  http: HttpClient,
  image: Buffer | string,
  options: {
    apiKey: string
    visualMatches?: boolean
    timeout?: number
    proxy?: string
  },
): Promise<PostCandidate[]> {
  if (!options.apiKey) throw new EngineError('Google Lens 需要 serpapi_api_key')

  // 本地字节 → SerpApi Image API 上传拿 image_id（独立于 Yandex 图床）。
  // 上传限制：JPG/PNG/WebP，≤500 KB，image_id 10 分钟有效。
  let imageId = ''
  if (Buffer.isBuffer(image)) {
    // SerpApi 只收 JPG/PNG/WebP 且 ≤500 KB：格式不支持或超限时强制转 JPEG
    const fmt = imageFormat(image)
    const allowed = fmt === 'jpeg' || fmt === 'png' || fmt === 'webp'
    const needsConvert = !allowed || image.length > 500 * 1024
    const payload = needsConvert
      ? await compressToMaxBytes(image, 500 * 1024, true)
      : image
    const meta = uploadMeta(payload)
    const resp = await http.postFile('https://serpapi.com/image', 'image', payload, {
      timeout: options.timeout,
      proxy: options.proxy,
      filename: meta.filename,
      contentType: meta.mime,
      extraFields: { api_key: options.apiKey },
    })
    const text = await resp.text()
    let upload: any
    try {
      upload = JSON.parse(text)
    } catch {
      upload = undefined
    }
    imageId = String(upload?.image_id || '')
    if (!imageId) {
      const reason =
        upload?.error || upload?.message || text.slice(0, 120) || '未知错误'
      throw new EngineError(`SerpApi 图片上传失败(HTTP ${resp.status}): ${reason}`)
    }
  }

  const kinds: Array<[string, number]> = [['exact_matches', 0.45]]
  if (options.visualMatches) kinds.push(['visual_matches', 0.15])

  const out: PostCandidate[] = []
  const seen = new Set<string>()
  for (const [kind, weight] of kinds) {
    const data: any = await http.getJson('https://serpapi.com/search.json', {
      timeout: options.timeout,
      proxy: options.proxy,
      query: {
        engine: 'google_lens',
        type: kind,
        ...(imageId
          ? { image_id: imageId }
          : { url: typeof image === 'string' ? image : '' }),
        safe: 'off',
        api_key: options.apiKey,
      },
    })
    if (data?.error) throw new EngineError(`Google Lens: ${String(data.error).slice(0, 120)}`)
    for (const item of data?.[kind] || []) {
      const link = item?.link || ''
      if (!link || seen.has(link)) continue
      seen.add(link)
      const source = item?.source || {}
      const page = source?.link || link
      if (seen.has(page)) continue
      seen.add(page)
      out.push({
        engine: 'gcl',
        pageUrl: page,
        title: source?.name || item?.title || '',
        imageUrl: item?.original || '',
        weight,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 免 Key Google Lens：直接上传图片并解析结果页
//
// 流程与 flj_finder 使用的 PicImageSearch 完全一致：
//   POST lens.google.com/v3/upload (multipart encoded_image)
//   → 上传响应里找 exact_matches 标签（udm=48）→ GET 该结果页
//   → 解析 .YxbOwd 条目（a.ngTNl / .ZhosBf / .xuPcX）
// Google 在部分出口 IP 上会返回“需要启用 JavaScript”的验证页，这时明确报错，
// 不把它当成“没有结果”。
// ---------------------------------------------------------------------------

const LENS_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' }

function lensHasClass(el: any, name: string): boolean {
  const cls = DomUtils.getAttributeValue(el, 'class') || ''
  return cls.split(/\s+/).includes(name)
}

function lensFind(nodes: any[], test: (el: any) => boolean): any {
  return DomUtils.findOne(test, nodes, true)
}

function lensText(el: any): string {
  if (!el) return ''
  return String(DomUtils.textContent(el) || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从内联脚本里提取 google.ldi 图片映射（Google 用 data-iid 引用）。 */
function extractLensImageMap(html: string): Map<string, string> {
  const map = new Map<string, string>()
  const m = html.match(/google\.ldi\s*=\s*(\{[^}]+\})/)
  if (!m) return map
  try {
    const obj = JSON.parse(
      m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&'),
    )
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') map.set(key, value)
    }
  } catch {
    // 脚本不是严格 JSON 时放弃图片映射，不影响页面/标题解析
  }
  return map
}

function lensImageUrl(img: any, map: Map<string, string>): string {
  const iid =
    DomUtils.getAttributeValue(img, 'data-iid') ||
    DomUtils.getAttributeValue(img, 'id') ||
    ''
  const mapped = iid ? map.get(iid) : ''
  if (mapped) return mapped
  const raw =
    DomUtils.getAttributeValue(img, 'data-src') ||
    DomUtils.getAttributeValue(img, 'src') ||
    ''
  return /^https?:\/\//i.test(raw) ? raw : ''
}

/** 把 Google 的跳转链接还原成目标页；站内链接直接丢弃。 */
function unwrapLensUrl(href: string): string {
  if (!href) return ''
  if (href.startsWith('/url?')) {
    try {
      const q = new URL(href, 'https://www.google.com').searchParams.get('q')
      if (q && /^https?:\/\//i.test(q)) return q
    } catch {
      return ''
    }
  }
  return /^https?:\/\//i.test(href) ? href : ''
}

/** 找到 exact_matches 标签的链接（udm=48）。 */
export function findLensExactHref(html: string): string {
  const doc = parseDocument(html)
  const anchor = lensFind(doc.children as any[], (el: any) => {
    if (el?.name !== 'a') return false
    const href = DomUtils.getAttributeValue(el, 'href') || ''
    return /[?&]udm(?:%3D|=)48(?:&|$)/i.test(href)
  })
  return anchor ? DomUtils.getAttributeValue(anchor, 'href') || '' : ''
}

function isLensBlockedPage(html: string): boolean {
  if (!html) return true
  if (/httpservice\/retry\/enablejs|enablejs\?sei=/i.test(html)) return true
  if (/consent\.google\.com|Before you continue to Google/i.test(html)) return true
  if (
    !html.includes('YxbOwd') &&
    /captcha|unusual traffic|sorry\/index/i.test(html)
  ) {
    return true
  }
  return false
}

export function parseLensExactHtml(html: string): PostCandidate[] {
  if (isLensBlockedPage(html)) {
    throw new EngineError(
      'Google Lens 返回验证页/需要 JavaScript（搜索未交付，非无结果）',
    )
  }

  const doc = parseDocument(html)
  const items = DomUtils.findAll(
    (el: any) => lensHasClass(el, 'YxbOwd'),
    doc.children as any[],
  )
  const imageMap = extractLensImageMap(html)
  const out: PostCandidate[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const anchor = lensFind([item], (el: any) => el?.name === 'a' && lensHasClass(el, 'ngTNl'))
    const pageUrl = unwrapLensUrl(
      anchor ? DomUtils.getAttributeValue(anchor, 'href') || '' : '',
    )
    if (!pageUrl || seen.has(pageUrl)) continue
    seen.add(pageUrl)

    const titleEl = lensFind([item], (el: any) => lensHasClass(el, 'ZhosBf'))
    const siteEl = lensFind([item], (el: any) => lensHasClass(el, 'xuPcX'))
    const img = lensFind([item], (el: any) => el?.name === 'img')

    out.push({
      engine: 'lens',
      pageUrl,
      title: lensText(titleEl),
      description: lensText(siteEl),
      imageUrl: img ? lensImageUrl(img, imageMap) : '',
      weight: 0.45,
    })
  }
  return out
}

export async function searchGoogleLensFree(
  http: HttpClient,
  image: Buffer,
  options: { timeout?: number; proxy?: string } = {},
): Promise<PostCandidate[]> {
  const upload = await http.postFile(
    'https://lens.google.com/v3/upload',
    'encoded_image',
    image,
    {
      timeout: options.timeout,
      proxy: options.proxy,
      filename: 'image.jpg',
      contentType: 'image/jpeg',
      headers: LENS_HEADERS,
    },
  )
  if (!upload.ok) throw new EngineError(`Google Lens 上传 HTTP ${upload.status}`)

  let html = await upload.text()

  // exact_matches 是单独一个标签页，需要再从上传结果页跳到 udm=48
  const exactHref = findLensExactHref(html)
  if (exactHref) {
    html = await http.getText(new URL(exactHref, 'https://www.google.com').toString(), {
      timeout: options.timeout,
      proxy: options.proxy,
      headers: LENS_HEADERS,
    })
  }

  return parseLensExactHtml(html)
}
