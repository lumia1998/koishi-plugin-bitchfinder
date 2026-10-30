/**
 * 多引擎反搜适配层。
 *
 * 每个引擎独立实现，返回统一的 PostCandidate 列表；任何引擎失败
 * （网络、风控、缺 key）都只影响自身，不影响其他引擎。
 */

import { HttpClient } from './http'
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

export async function searchSaucenao(
  http: HttpClient,
  imageUrl: string,
  options: { apiKey: string; timeout?: number; proxy?: string },
): Promise<PostCandidate[]> {
  if (!options.apiKey) {
    throw new EngineError('SauceNAO 需要 api_key（saucenao.com 免费注册，100 次/天）')
  }
  const data = await http.getJson('https://saucenao.com/search.php', {
    timeout: options.timeout,
    proxy: options.proxy,
    query: {
      db: 999,
      output_type: 2,
      numres: 16,
      api_key: options.apiKey,
      url: imageUrl,
    },
  })

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
// Baidu 识图：graph.baidu.com 上传 → pcsimi 相同/相似结果（线索级）
// ---------------------------------------------------------------------------

export async function searchBaidu(
  http: HttpClient,
  image: Buffer,
  options: { timeout?: number; proxy?: string },
): Promise<PostCandidate[]> {
  const data: any = await http.postFileJson('https://graph.baidu.com/upload', 'image', image, {
    timeout: options.timeout,
    proxy: options.proxy,
    filename: 'blob',
    contentType: 'image/jpeg',
    query: { uptime: Date.now(), tn: 'pc', from: 'pc' },
  })
  if (Number(data?.status) !== 0) {
    throw new EngineError(`Baidu upload status=${data?.status}`)
  }
  const pageUrl: string = data?.result?.url || ''
  if (!pageUrl) throw new EngineError('Baidu upload 未返回结果页 URL')

  const ajaxUrl = pageUrl.replace('/similar', '/ajax/pcsimi')
  const res = await http.getJson(ajaxUrl, {
    timeout: options.timeout,
    proxy: options.proxy,
    query: { tn: 'pc' },
  })

  const out: PostCandidate[] = []
  const seen = new Set<string>()
  for (const card of res?.card || []) {
    for (const item of card?.same || []) {
      const url = item?.url || ''
      if (url && !seen.has(url)) {
        seen.add(url)
        out.push({
          engine: 'baidu',
          pageUrl: url,
          title: item?.title || item?.titleStr || '',
          imageUrl: item?.thumbUrl || '',
          weight: 0.2,
        })
      }
    }
  }
  if (!out.length) throw new EngineError('Baidu 未解析到结果（结构可能已变更）')
  return out
}

// ---------------------------------------------------------------------------
// Copyseeker：按图检索收录页面，常直接给出 X 帖子（线索级）
// ---------------------------------------------------------------------------

export async function searchCopyseeker(
  http: HttpClient,
  image: Buffer,
  options: { timeout?: number; proxy?: string },
): Promise<PostCandidate[]> {
  const data: any = await http.postFileJson(
    'https://copyseeker.net/api/discovery',
    'image',
    image,
    {
      timeout: options.timeout,
      proxy: options.proxy,
      filename: 'blob',
      contentType: 'image/jpeg',
    },
  )
  const token = data?.token || data?.id
  if (!token) throw new EngineError('Copyseeker 未返回 discovery token')

  let results: any[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      const rdata: any = await http.getJson(
        `https://copyseeker.net/api/discovery/${token}/results`,
        { timeout: options.timeout, proxy: options.proxy },
      )
      results = rdata?.results || []
      if (results.length) break
    } catch {
      // 单次轮询失败不致命
    }
  }
  if (!results.length) throw new EngineError('Copyseeker 超时未取得结果')

  const out: PostCandidate[] = []
  const seen = new Set<string>()
  for (const item of results) {
    const url = item?.url || ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      engine: 'copyseeker',
      pageUrl: url,
      title: item?.title || '',
      imageUrl: item?.imageUrl || item?.thumbUrl || '',
      weight: 0.2,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// SerpApi Google Lens：exact_matches 完全匹配（官方第三方 API，付费）
// ---------------------------------------------------------------------------

export async function searchGoogleLens(
  http: HttpClient,
  imageUrl: string,
  options: {
    apiKey: string
    visualMatches?: boolean
    timeout?: number
    proxy?: string
  },
): Promise<PostCandidate[]> {
  if (!options.apiKey) throw new EngineError('Google Lens 需要 serpapi_api_key')

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
        url: imageUrl,
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
