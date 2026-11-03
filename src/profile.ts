// 从 X 主页的 og 元数据取显示名和头像。
//
// Lens 的候选标题不一定是「X 名字(@handle) / X」这种带平台徽标的卡片，
// X 官方页面标题又是「Naimi奶咪 (@Anaimiya2) / X」，开头没有徽标；
// 直接抓主页 HTML 里的 og:title / og:image 比从搜索标题里猜可靠得多。
// 任何失败都返回 null —— 名字退回原来的逻辑，头像直接不发，绝不影响找鸡结果。
import { looksLikeImageBuffer } from './safe-fetch'
import { sniffMime } from './image'

export interface XProfile {
  name: string
  avatar?: Buffer
  avatarMime?: string
}

const X_HANDLE_RE = /^[A-Za-z0-9_]{2,20}$/
const PROFILE_TIMEOUT_MS = 8000
const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function decodeEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)) } catch { return '' }
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 从 HTML 里取某个 meta 的 content（属性顺序不固定，逐个 meta 标签查）。 */
export function metaContent(html: string, key: string): string {
  const tags = String(html ?? '').match(/<meta\b[^>]*>/gi) ?? []
  const keyRe = new RegExp(`(?:property|name)\\s*=\\s*["']${key}["']`, 'i')
  for (const tag of tags) {
    if (!keyRe.test(tag)) continue
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)
    if (content) return decodeEntities(content[1])
  }
  return ''
}

/**
 * 从 X 页面标题里取出显示名：`Naimi奶咪 (@Anaimiya2) on X` / `Naimi奶咪 (@Anaimiya2) / X`。
 * 括号里的 handle 必须和要查的号一致，否则宁可不认 —— 防止拿到「推荐关注」之类的标题。
 */
export function nameFromProfileTitle(title: string, handle: string): string {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  const m = text.match(/^(.{1,48}?)\s*[（(]\s*@([A-Za-z0-9_]{2,20})\s*[)）]/)
  if (!m) return ''
  const expected = String(handle ?? '').replace(/^@/, '').trim().toLowerCase()
  if (!expected || m[2].toLowerCase() !== expected) return ''
  const name = m[1].trim().replace(/[:：]+$/, '')
  if (!name || name.replace(/^@/, '').toLowerCase() === m[2].toLowerCase()) return ''
  if (name.length > 40 || /["':：/|]/.test(name)) return ''
  if (/\b(on|via|by)\s+(x|twitter)\b/i.test(name)) return ''
  return name
}

/** 下载头像；失败/超限/不是图片都返回 undefined。 */
async function downloadAvatar(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8' }
    })
    if (!response.ok) return undefined
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) return undefined
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > maxBytes) return undefined
    if (!looksLikeImageBuffer(bytes)) return undefined
    return bytes
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓 X 主页，返回显示名和头像。handle 已经是去掉 @ 的用户名。
 * 只认 pbs.twimg.com/profile_images 下的头像，避免把别的主机带进来。
 */
export async function fetchXProfile(handle: string, options: { timeoutMs?: number; avatarMaxBytes?: number } = {}): Promise<XProfile | null> {
  const name = String(handle ?? '').replace(/^@/, '').trim()
  if (!X_HANDLE_RE.test(name)) return null
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || PROFILE_TIMEOUT_MS)
  const maxBytes = Math.max(1024, Number(options.avatarMaxBytes) || AVATAR_MAX_BYTES)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://x.com/${name}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }
    })
    if (!response.ok) return null
    const html = await response.text()
    const title = metaContent(html, 'og:title') || metaContent(html, 'twitter:title')
    const displayName = nameFromProfileTitle(title, name)
    const avatarUrl = metaContent(html, 'og:image')
    let avatar: Buffer | undefined
    if (/^https:\/\/pbs\.twimg\.com\/profile_images\//i.test(avatarUrl)) {
      avatar = await downloadAvatar(avatarUrl, timeoutMs, maxBytes)
    }
    if (!displayName && !avatar) return null
    return { name: displayName, avatar, avatarMime: avatar ? sniffMime(avatar) : undefined }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
