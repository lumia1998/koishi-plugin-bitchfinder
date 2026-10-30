/**
 * 跨引擎证据融合与置信度评分。
 *
 * 置信度模型（0-1，封顶）：
 * - 正文署名（Yandex 转发者正文中注明原作者）：+0.35/次
 * - SauceNAO 返回的作者（官方索引）：+0.45，且附原帖
 * - ascii2d 结果作者：+0.30，且附原帖
 * - 标题/URL handle（可能是转发者）：+0.10/次
 * - 感知哈希同图硬确认（>=0.90）：+0.20；0.75-0.90 可疑：+0.05
 */

import { PostCandidate } from './types'

export const TITLE_HANDLE_RE = /@([A-Za-z0-9_]{1,20})/
export const X_URL_RE =
  /(?:x\.com|twitter\.com|sotwe\.com|urlebird\.com)\/(?:user\/)?@?([A-Za-z0-9_]{2,20})(?:[/?]|$)/
export const DESC_CREDIT_RE =
  /(?:sc|credit|cr|source|via|cn|photo|drawn\s+by|tw)\s*[:：]\s*@?([A-Za-z0-9_]{2,20})|([A-Za-z0-9_]{2,20})['’]s\s+(?:tweet\s+)?(?:photo|video|status|post)/g
const DESC_MENTION_RE = /@([A-Za-z0-9_]{2,20})/g
const STATUS_RE = /(?:x\.com|twitter\.com)\/(\w{2,20})\/status\/(\d+)/

const STOPWORDS = new Set([
  'status',
  'search',
  'user',
  'home',
  'intent',
  'sunna',
  'sc',
  'i',
  'web',
  'crypto',
  'bitcoin',
  'forum',
])

const HANDLE_LIKE_RE = /^[A-Za-z0-9_]{4,20}$/
const HANDLE_PREFIX_RE = /^[A-Za-z0-9_]{4,20}/
const LETTER_RE = /[A-Za-z]/

const TITLE_NOISE = new Set([
  'nude', 'leaks', 'leaked', 'onlyfans', 'patreon', 'photo', 'photos',
  'video', 'videos', 'naked', 'sexy', 'cosplay', 'forum', 'wall', 'free',
  'top', 'best', 'girl', 'girls', 'asian', 'japanese', 'leakedmodels',
  'fappening', 'fapeza', 'fapello', 'nudostar', 'nudogram', 'fapodrop',
  'tokyomotion', 'sotwe', 'urlebird', 'twitter', 'profile', 'голая',
  'фото', 'сливы', 'page', 'pages', 'index', 'home', 'main', 'list',
  'category', 'tag', 'search', 'archive', 'post', 'posts', 'comments',
  'login', 'update', 'aliexpress', 'imall', 'telegra', 'telegram',
  'telegraph', 'vikacg', 'alibaba', 'amazon', 'ebay', 'reddit', 'google',
  'yandex', 'bing', 'kitty', 'welfare', 'silver', 'misty', 'models',
  'model', 'chat', 'android', 'download', 'downloads', 'app', 'apps',
  'apk', 'ios', 'windows', 'online', 'watch', 'hd', 'full', 'game',
  'games', 'gaming', 'anime', 'manga', 'novel', 'comics', 'music',
  'movie', 'movies', 'shop', 'store', 'market', 'price', 'review',
  'reviews', 'guide', 'guides', 'wiki', 'news', 'blog', 'video', 'pics',
  'images', 'gallery', 'leak', 'onlyfan', 'premium', 'vip', 'mod', 'mods',
  'hack', 'unlock', 'crack', 'torrent', 'magnet', 'stream', 'hentai',
  'ecchi', 'waifu',
])

// 聚合站跨站人名通道的硬门槛：必须含数字或下划线。
const AGGREGATOR_STRICT_RE = /\d|_/

export function isHandleLike(token: string): boolean {
  if (!HANDLE_LIKE_RE.test(token)) return false
  if (!LETTER_RE.test(token)) return false
  if (TITLE_NOISE.has(token.toLowerCase())) return false
  return true
}

function domainRoot(url: string): string {
  if (!url.includes('://')) return ''
  let host = url.split('/')[2] || ''
  host = host.split(':')[0]
  let parts = host.split('.')
  if (parts.length > 2 && parts[0].length <= 3) parts = parts.slice(1)
  return parts.join('.')
}

export function cleanHandle(handle: string | null | undefined): string {
  if (!handle) return ''
  if (STOPWORDS.has(handle.toLowerCase())) return ''
  return handle.replace(/^@+/, '').trim()
}

export interface AuthorVerdict {
  handle: string
  platform: string
  confidence: number
  postUrl: string
  pageUrl: string
  evidence: string[]
  domains: Set<string>
}

export function fuse(
  candidates: PostCandidate[],
  phashScores: Record<string, number> = {},
): AuthorVerdict[] {
  const authors = new Map<string, AuthorVerdict>()

  const author = (handle: string, platform: string): AuthorVerdict => {
    const key = `${handle.toLowerCase()}|${platform}`
    let a = authors.get(key)
    if (!a) {
      a = {
        handle,
        platform,
        confidence: 0,
        postUrl: '',
        pageUrl: '',
        evidence: [],
        domains: new Set(),
      }
      authors.set(key, a)
    }
    return a
  }

  for (const c of candidates) {
    const postUrl = c.postUrl || ''
    const statusMatch = postUrl.match(STATUS_RE) || (c.pageUrl || '').match(STATUS_RE)
    const pixivMatch = (postUrl || c.pageUrl || '').match(/pixiv\.net\/artworks\/(\d+)/)

    if (c.engine === 'saucenao' && c.authorHandle) {
      const a = author(c.authorHandle, c.authorPlatform || 'X/Twitter')
      a.confidence = Math.min(1, a.confidence + 0.45)
      a.evidence.push(`SauceNAO 索引命中: ${c.pageUrl.slice(0, 70)}`)
      if (statusMatch) a.postUrl = statusMatch[0]
      else if (pixivMatch) a.postUrl = `https://www.pixiv.net/artworks/${pixivMatch[1]}`
    } else if (c.engine === 'ascii2d' && c.authorHandle) {
      const a = author(c.authorHandle, c.authorPlatform || 'X/Twitter')
      a.confidence = Math.min(1, a.confidence + 0.30)
      a.evidence.push(`ascii2d 结果: ${c.pageUrl.slice(0, 70)}`)
      if (statusMatch && !a.postUrl) a.postUrl = statusMatch[0]
    } else if (c.engine === 'yandex') {
      const platform = platformOf(c)
      const root = domainRoot(c.pageUrl)
      const titleMatch = (c.title || '').match(TITLE_HANDLE_RE) || c.pageUrl.match(X_URL_RE)
      const titleHandle = titleMatch ? cleanHandle(titleMatch[1]) : ''

      // 1) description 强署名（credit 模式，原作者）
      for (const m of (c.description || '').matchAll(DESC_CREDIT_RE)) {
        const h = cleanHandle(m[1] || m[2])
        if (!h) continue
        const a = author(h, platform)
        a.confidence = Math.min(1, a.confidence + 0.35)
        a.domains.add(root)
        const start = Math.max(0, (m.index || 0) - 15)
        a.evidence.push(
          `转发正文署名: “…${(c.description || '').slice(start, (m.index || 0) + m[0].length + 10)}…”`,
        )
        if (!a.pageUrl) a.pageUrl = c.pageUrl
        if (statusMatch && !a.postUrl) a.postUrl = statusMatch[0]
      }

      // 2) description 裸 @mention：只有与页面标题 handle 不同才算独立弱证据
      for (const m of (c.description || '').matchAll(DESC_MENTION_RE)) {
        const h = cleanHandle(m[1])
        if (!h || h.toLowerCase() === titleHandle.toLowerCase()) continue
        const a = author(h, platform)
        a.confidence = Math.min(1, a.confidence + 0.10)
        a.domains.add(root)
        a.evidence.push(`正文提及: @${h}`)
        if (!a.pageUrl) a.pageUrl = c.pageUrl
      }

      // 3) 标题/URL handle（转发者）—— 但跨域名一致性提权
      if (titleHandle) {
        const a = author(titleHandle, platform)
        if (!a.domains.has(root)) {
          a.confidence = Math.min(1, a.confidence + (a.domains.size ? 0.15 : 0.10))
          a.domains.add(root)
        } else {
          a.confidence = Math.min(1, a.confidence + 0.05)
        }
        a.evidence.push(`站点署名(${root}): ${c.pageUrl.slice(0, 55)}`)
        if (!a.pageUrl) a.pageUrl = c.pageUrl
      }

      // 4) 聚合站标题开头的 handle 形态词
      if (!platform) {
        for (const rawToken of (c.title || '').split(/\s+/)) {
          const tok = rawToken
            .replace(/^[,.;:!?()[\]{}'"`]+|[,.;:!?()[\]{}'"`]+$/g, '')
            .split('-')[0]
          if (!isHandleLike(tok)) continue
          if (!AGGREGATOR_STRICT_RE.test(tok)) continue
          const a = author(tok, '未知')
          if (!a.domains.has(root)) {
            a.domains.add(root)
            if (a.domains.size >= 2) {
              a.confidence = Math.min(0.30, a.confidence + 0.10)
              a.evidence.push(
                `聚合站人名(跨站一致 x${a.domains.size}): ${(c.title || '').slice(0, 50)}`,
              )
              if (!a.pageUrl) a.pageUrl = c.pageUrl
            }
          } else {
            a.confidence = Math.min(0.30, a.confidence + 0.05)
          }
        }

        // URL 路径中的 handle 形态段
        for (let seg of c.pageUrl.split('/').slice(3)) {
          seg = seg.split('?')[0]
          const m2 = seg.match(HANDLE_PREFIX_RE)
          if (!m2 || !isHandleLike(m2[0])) continue
          const target = authors.get(`${m2[0].toLowerCase()}|未知`)
          if (!target) continue // 只为已被其他证据登记的 handle 记域名
          if (!target.domains.has(root)) {
            target.domains.add(root)
            if (target.domains.size >= 2) {
              target.confidence = Math.min(0.30, target.confidence + 0.10)
              target.evidence.push(`URL 路径含该名(${root})`)
            }
          }
        }
      }
    } else if (c.engine === 'gcv') {
      const m = c.pageUrl.match(/(?:x\.com|twitter\.com)\/(\w{2,20})\/?$/)
      const h = m ? cleanHandle(m[1]) : ''
      if (h) {
        const a = author(h, 'X/Twitter')
        a.confidence = Math.min(1, a.confidence + 0.15)
        a.evidence.push(`Google Vision 匹配页: ${c.pageUrl.slice(0, 70)}`)
      }
    }
  }

  // 感知哈希加成：转发页同样含同图，"页面含同图"≠"该页账号是作者"。
  for (const [key, a] of authors) {
    const hLower = key.split('|')[0]
    const sim = phashScores[hLower] || 0
    if (sim >= 0.9) {
      if (a.domains.size >= 2) {
        a.confidence = Math.min(1, a.confidence + 0.20)
        a.evidence.push(`感知哈希同图确认(跨${a.domains.size}域): ${Math.round(sim * 100)}%`)
      } else {
        a.confidence = Math.min(1, a.confidence + 0.10)
        a.evidence.push(`同图出现在其页面(单域,或为转发): ${Math.round(sim * 100)}%`)
      }
    } else if (sim >= 0.75) {
      a.confidence = Math.min(1, a.confidence + 0.05)
      a.evidence.push(`感知哈希可疑相似: ${Math.round(sim * 100)}%`)
    }
  }

  return [...authors.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .filter((a) => a.confidence >= 0.1)
}

export function platformOf(c: PostCandidate): string {
  const host = c.pageUrl.includes('://') ? c.pageUrl.split('/')[2] || '' : ''
  const hostname = host.split(':')[0]
  const table: Array<[string, string]> = [
    ['x.com', 'X/Twitter'],
    ['twitter.com', 'X/Twitter'],
    ['sotwe.com', 'X/Twitter'],
    ['urlebird.com', 'X/Twitter'],
    ['weibo.com', '微博'],
    ['weibo.cn', '微博'],
    ['xiaohongshu.com', '小红书'],
    ['instagram.com', 'Instagram'],
    ['pixiv.net', 'Pixiv'],
    ['danbooru.donmai.us', 'Danbooru'],
    ['coser.one', 'Cosplay站'],
    ['cosppi.net', 'Cosplay站'],
  ]
  for (const [prefix, name] of table) {
    if (hostname === prefix || hostname.endsWith('.' + prefix)) return name
  }
  return ''
}

/** 强证据阈值：有正文署名/官方引擎命中/同图确认之一才作为"作者候选"展示 */
export const STRONG_CONFIDENCE = 0.30

/** 格式化融合结果：只突出最优先一条，其余折叠。 */
export function formatVerdicts(verdicts: AuthorVerdict[], limit = 5): string {
  if (!verdicts.length) {
    return (
      '未能确定作者候选（各引擎均无署名证据）。\n' +
      '提示：配置 SauceNAO api_key 可显著提升原帖命中率。'
    )
  }

  for (const v of verdicts) {
    if (v.platform === '未知') v.platform = '身份(站内人名)'
  }

  const strong = verdicts.filter((v) => v.confidence >= STRONG_CONFIDENCE)
  const weak = verdicts.filter((v) => v.confidence < STRONG_CONFIDENCE)
  const lines: string[] = []

  if (strong.length) {
    const best = strong[0]
    lines.push(`最优先候选：@${best.handle}  [${best.platform}]`)
    lines.push(`  置信度 ${best.confidence.toFixed(2)}（正文署名/官方引擎/同图确认）`)
    if (best.postUrl) lines.push(`  原帖: ${best.postUrl}`)
    else if (best.pageUrl) lines.push(`  证据页: ${best.pageUrl}`)
    for (const ev of best.evidence.slice(0, 3)) lines.push(`  · ${ev}`)

    const rest = strong.slice(1)
    if (rest.length) {
      lines.push(`其余 ${rest.length} 位候选（置信度较低，已折叠，仅供人工排查）：`)
      for (const v of rest.slice(0, Math.max(0, limit - 1))) {
        const post = v.postUrl || v.pageUrl
        lines.push(`  - @${v.handle}  [${v.platform}]  ${v.confidence.toFixed(2)}  ${post}`)
      }
    }
  } else {
    lines.push('未找到可靠署名证据（无正文 credit、无官方引擎命中、无同图确认）。')
    lines.push('以下仅为结果页中出现过的账号，多为转发者，低可信：')
    for (const v of weak.slice(0, limit)) {
      lines.push(`  ? @${v.handle}  [${v.platform}]  置信度 ${v.confidence.toFixed(2)}`)
    }
  }

  if (strong.length && weak.length) {
    lines.push(`（另有 ${weak.length} 个仅弱证据账号，多为转发者，已折叠）`)
  }
  if (!strong.length) {
    lines.push('提示：配置 SauceNAO api_key 可显著提升原帖命中率。')
  }

  // 身份类候选（站内人名，无平台归属）附 X 搜索验证链接
  const withLinks: string[] = []
  for (const line of lines) {
    withLinks.push(line)
    if (line.includes('[身份(站内人名)]')) {
      const handle = line.split('@')[1]?.split(' ')[0]
      if (handle) withLinks.push(`      X 搜索验证: https://x.com/search?q=${handle}`)
    }
  }
  return withLinks.join('\n')
}
