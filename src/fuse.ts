/**
 * 跨引擎证据融合与置信度评分。
 *
 * 置信度模型（0-1，封顶）：
 * - 正文署名（Yandex 转发者正文中注明原作者）：+0.35/次
 * - SauceNAO 返回的作者（官方索引）：+0.45，且附原帖
 * - Google Lens 完全匹配到 X 原帖/主页：+0.30 / +0.20
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
// matchAll 要求全局正则；TITLE_HANDLE_RE 保持非全局以兼容 String#match
const TITLE_HANDLE_GLOBAL_RE = new RegExp(TITLE_HANDLE_RE.source, 'g')
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
const LETTER_RE = /[A-Za-z]/

// 标题里的独立 handle/人名形态词（聚合站标题通常以人名开头或跟分隔符）
const AGG_TOKEN_RE =
  /(?:^|[\s\-–—|:：,，。.、()（）[\]【】])([A-Za-z][A-Za-z0-9_]{3,19})(?=[\s\-–—|:：,，。.、()（）[\]【】]|$)/g

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

export function domainRoot(url: string): string {
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

/**
 * 归一化来源文字：Yandex 会把中文逐字拆开（"奶 咪"），
 * 这里去掉 CJK 字符之间的空格并统一大小写。
 */
export function normalizeText(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .replace(/([　-鿿豈-﫿])\s+(?=[　-鿿豈-﫿])/g, '$1')
    .toLowerCase()
}

/** 文本里是否出现该账号名（带不带 @ 均可，边界按 ASCII 词字符判断）。 */
export function textMentions(text: string | null | undefined, handle: string): boolean {
  const h = handle.toLowerCase().trim()
  if (!h) return false
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9_])@?${escaped}(?![a-z0-9_])`).test(normalizeText(text))
}

/**
 * 统计 X 资料页昵称在多少个独立站点文字中出现。
 * 用于确认"页面标题里的名字"与该账号是同一个人，而不是同名账号。
 */
export function nameMatchDomains(
  candidates: PostCandidate[],
  name: string,
): Set<string> {
  const domains = new Set<string>()
  const bare = (name || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  if (bare.length < 4 || !LETTER_RE.test(bare)) return domains
  for (const c of candidates) {
    const text = normalizeText(`${c.title || ''} ${c.description || ''}`).replace(/\s+/g, '')
    if (text.includes(bare)) domains.add(domainRoot(c.pageUrl))
  }
  return domains
}

export interface AuthorVerdict {
  handle: string
  platform: string
  confidence: number
  postUrl: string
  pageUrl: string
  evidence: string[]
  domains: Set<string>
  /** X 资料页昵称（经 fxTwitter 核实） */
  profileName?: string
  /** X 粉丝数（经 fxTwitter 核实） */
  followers?: number | null
  /** 是否已通过资料页确认该 handle 是一个真实 X 账号 */
  profileVerified?: boolean
}

export function fuse(
  candidates: PostCandidate[],
  phashScores: Record<string, number> = {},
): AuthorVerdict[] {
  const authors = new Map<string, AuthorVerdict>()
  // 免 Key Lens 与 SerpApi Lens 查的是同一个索引，同一结果页只计一次
  const lensSeen = new Set<string>()

  // 先收集"明确出现过"的账号名：@提及、X 链接、聚合站标题人名。
  // 只有这些名字才参与跨站一致性统计，避免把普通英文单词当账号。
  const explicitHandles = new Set<string>()
  const addExplicit = (raw: string | null | undefined) => {
    const h = cleanHandle(raw)
    if (h) explicitHandles.add(h.toLowerCase())
  }
  const aggTokenRoots = new Map<string, Set<string>>()
  for (const c of candidates) {
    addExplicit(c.authorHandle)
    for (const m of (c.title || '').matchAll(TITLE_HANDLE_GLOBAL_RE)) addExplicit(m[1])
    for (const m of (c.description || '').matchAll(DESC_MENTION_RE)) addExplicit(m[1])
    const um = (c.pageUrl || '').match(X_URL_RE)
    if (um) addExplicit(um[1])
    if (c.engine === 'yandex') {
      const root = domainRoot(c.pageUrl)
      for (const m of (c.title || '').matchAll(AGG_TOKEN_RE)) {
        const token = m[1]
        if (!isHandleLike(token) || !AGGREGATOR_STRICT_RE.test(token)) continue
        const roots = aggTokenRoots.get(token.toLowerCase()) || new Set<string>()
        roots.add(root)
        aggTokenRoots.set(token.toLowerCase(), roots)
      }
    }
  }
  // 聚合站人名必须至少出现在两个独立域名的标题里，才是"这套图的署名"，
  // 而不是某个文件名/随机串。
  for (const [token, roots] of aggTokenRoots) {
    if (roots.size >= 2) explicitHandles.add(token)
  }

  // 跨站一致署名：同一个名字在多个独立域名页面的标题/摘要里反复出现，
  // 说明这是该套图的署名，而不是某个转发页的偶然提及。
  interface ConsensusRecord {
    domains: Map<string, { pageUrl: string; title: string }>
    platform: string
    postUrl: string
  }
  const consensus = new Map<string, ConsensusRecord>()

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
      const platform = platformOf(c) || '未知'
      const root = domainRoot(c.pageUrl)
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

      // 2) 记录跨站署名：已知账号名出现在标题/摘要/URL 中即记一个域名，
      //    具体分值在循环结束后按独立域名数统一计算。
      const text = `${c.title || ''} ${c.description || ''}`
      for (const h of explicitHandles) {
        if (!textMentions(text, h) && !textMentions(c.pageUrl, h)) continue
        let rec = consensus.get(h)
        if (!rec) {
          rec = { domains: new Map(), platform: '', postUrl: '' }
          consensus.set(h, rec)
        }
        if (!rec.domains.has(root)) {
          rec.domains.set(root, {
            pageUrl: c.pageUrl,
            title: (c.title || c.description || '').slice(0, 60),
          })
        }
        if (!rec.platform) rec.platform = platform
        if (statusMatch && !rec.postUrl) rec.postUrl = statusMatch[0]
      }
    } else if (c.engine === 'gcv') {
      const m = c.pageUrl.match(/(?:x\.com|twitter\.com)\/(\w{2,20})\/?$/)
      const h = m ? cleanHandle(m[1]) : ''
      if (h) {
        const a = author(h, 'X/Twitter')
        a.confidence = Math.min(1, a.confidence + 0.15)
        a.evidence.push(`Google Vision 匹配页: ${c.pageUrl.slice(0, 70)}`)
      }
    } else if (c.engine === 'lens' || c.engine === 'gcl') {
      const key = (c.pageUrl || '').replace(/\/+$/, '').toLowerCase()
      if (!key || lensSeen.has(key)) continue
      lensSeen.add(key)

      const label = c.engine === 'lens' ? 'Google Lens' : 'SerpApi Lens'
      const root = domainRoot(c.pageUrl)

      if (statusMatch) {
        // exact_matches 直接命中 X 原帖：这是最可靠的开箱即用证据
        const a = author(statusMatch[1], 'X/Twitter')
        a.confidence = Math.min(1, a.confidence + 0.30)
        a.domains.add(root)
        if (!a.postUrl) a.postUrl = statusMatch[0]
        if (!a.pageUrl) a.pageUrl = c.pageUrl
        a.evidence.push(`${label} 完全匹配原帖: ${c.pageUrl.slice(0, 70)}`)
      } else {
        const profileMatch = c.pageUrl.match(
          /(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{2,20})\/?(?:[?#]|$)/,
        )
        const titleMatch = (c.title || '').match(TITLE_HANDLE_RE)
        const h = profileMatch
          ? cleanHandle(profileMatch[1])
          : titleMatch
            ? cleanHandle(titleMatch[1])
            : ''
        if (h) {
          const a = author(h, 'X/Twitter')
          a.confidence = Math.min(1, a.confidence + (profileMatch ? 0.20 : 0.10))
          a.domains.add(root)
          if (!a.pageUrl) a.pageUrl = c.pageUrl
          a.evidence.push(`${label} 匹配页: ${c.pageUrl.slice(0, 70)}`)
        }
      }
    }
  }

  // 跨站一致署名计分：1 个域名 +0.10，每多一个独立域名 +0.05，封顶 0.45。
  // 这是开箱即用场景下最重要的线索：同一套图的署名会被多个聚合站反复引用。
  for (const [h, rec] of consensus) {
    const n = rec.domains.size
    if (!n) continue
    const a = author(h, rec.platform || '未知')
    const bonus = Math.min(0.45, 0.10 + 0.05 * (n - 1))
    a.confidence = Math.min(1, a.confidence + bonus)
    for (const root of rec.domains.keys()) a.domains.add(root)
    if (rec.postUrl && !a.postUrl) a.postUrl = rec.postUrl
    const sample = [...rec.domains.values()][0]
    if (!a.pageUrl) a.pageUrl = sample.pageUrl
    a.evidence.push(`跨站一致署名(${n} 个独立站点): “${sample.title}”`)
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

function formatFollowers(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return ''
  if (count >= 1e8) return `${(count / 1e8).toFixed(2)} 亿`
  if (count >= 1e4) return `${(count / 1e4).toFixed(1)} 万`
  return String(count)
}

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
    const nameTag = best.profileName ? `（${best.profileName}）` : ''
    lines.push(`最优先候选：@${best.handle}${nameTag}  [${best.platform}]`)
    lines.push(`  置信度 ${best.confidence.toFixed(2)}（正文署名/跨站一致署名/同图确认）`)
    if (best.postUrl) lines.push(`  原帖: ${best.postUrl}`)
    else if (best.profileVerified) {
      const fans = formatFollowers(best.followers)
      lines.push(`  主页: https://x.com/${best.handle}${fans ? ` · 粉丝 ${fans}` : ''}`)
      if (best.pageUrl) lines.push(`  证据页: ${best.pageUrl}`)
    } else if (best.pageUrl) lines.push(`  证据页: ${best.pageUrl}`)
    for (const ev of best.evidence.slice(0, 3)) lines.push(`  · ${ev}`)

    const rest = strong.slice(1)
    if (rest.length) {
      lines.push(`其余 ${rest.length} 位候选（置信度较低，已折叠，仅供人工排查）：`)
      for (const v of rest.slice(0, Math.max(0, limit - 1))) {
        const post = v.postUrl || v.pageUrl
        const name = v.profileName ? `（${v.profileName}）` : ''
        lines.push(`  - @${v.handle}${name}  [${v.platform}]  ${v.confidence.toFixed(2)}  ${post}`)
      }
    }
  } else {
    lines.push('未找到可靠署名证据（无正文 credit、无官方引擎命中、无同图确认）。')
    lines.push('以下仅为结果页中出现过的账号，多为转发者，低可信：')
    for (const v of weak.slice(0, limit)) {
      const name = v.profileName ? `（${v.profileName}）` : ''
      lines.push(`  ? @${v.handle}${name}  [${v.platform}]  置信度 ${v.confidence.toFixed(2)}`)
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
