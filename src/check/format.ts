// 鉴定报告与烧鸡榜的文本 / 合并转发格式。
import { h } from 'koishi'
import { sniffMime } from '../image'
import { looksLikeImageBuffer } from '../safe-fetch'
import { positiveLabel, resultTags, riskLabel, scoreTier } from './score'
import type { RankCategory } from './rank'
import type { AccountRow, RankEntry } from './types'

export interface RankGroup {
  category: RankCategory
  rows: RankEntry[]
}

export const X_PROFILE = 'https://x.com/'

export function profileUrl(handle: string): string {
  return X_PROFILE + handle
}

/** 单个账号的文字报告，控制在 900 字以内（QQ 长消息容易被截）。 */
export function formatReport(row: AccountRow, options: { cached?: boolean; stale?: boolean } = {}): string {
  const tier = scoreTier(row.score)
  const lines: string[] = []
  lines.push(`🔍 鉴定结果 · @${row.handle}`)
  if (row.displayName) lines.push(`👤 ${row.displayName}`)
  lines.push(`📊 可信度 ${row.score}/200（${tier.icon} ${tier.label}）`)

  const tags = resultTags(row)
  if (tags.length) lines.push(`🏷️ ${tags.slice(0, 8).join(' · ')}`)

  const stats = [
    row.followers != null ? `粉丝 ${compact(row.followers)}` : '',
    row.tweets != null ? `发帖 ${compact(row.tweets)}` : '',
    row.accountAgeYears != null ? `号龄 ${row.accountAgeYears.toFixed(1)} 年` : '',
    row.isVerified === true ? '蓝V' : '',
    row.language ?? ''
  ].filter(Boolean)
  if (stats.length) lines.push(`📈 ${stats.join(' · ')}`)

  const good: string[] = []
  if (row.positives > 0) good.push(`好评 ${row.positives} 条`)
  const goodTags = row.positiveTags.map(positiveLabel)
  if (goodTags.length) good.push(goodTags.join('、'))
  if (good.length) {
    lines.push(`👍 ${good.join('：')}`)
    const quote = quoteOf(row.positiveExamples)
    if (quote) lines.push(`   “${quote}”`)
  }

  if (row.complaints > 0 || row.riskTags.length) {
    const bad = `👎 差评 ${row.complaints} 条`
    const badTags = row.riskTags.map(riskLabel)
    lines.push(badTags.length ? `${bad}：${badTags.join('、')}` : bad)
    for (const example of (row.complaintExamples ?? []).slice(0, 2)) {
      const quote = quoteOf([example])
      if (quote) lines.push(`   “${quote}”`)
    }
  } else {
    lines.push('✅ 暂未搜到差评或风险标签')
  }

  if (row.detail) {
    const detail = row.detail.length > 300 ? `${row.detail.slice(0, 300)}…` : row.detail
    lines.push(`📝 ${detail.replace(/\s+/g, ' ')}`)
  }
  lines.push(`🔗 ${profileUrl(row.handle)}`)

  if (options.stale) {
    lines.push('⚠️ 这次没搜成功，先给你看上次的结果。')
  } else if (options.cached) {
    lines.push(`🔁 数据库里已有记录（想重新查：鉴定 ${row.handle} 刷新）`)
  }

  return trimLines(lines, 900)
}

/** 合并转发：每个分类一个节点，节点里按名次放头像 / 名字 / 主页。
 *
 * 头像必须先在本地下载成字节再塞进节点（h.image(Buffer) → data URI → OneBot 的 base64://）。
 * 节点里直接放远程 URL 时，由机器人宿主去 pbs.twimg.com 下载，墙、超时或 403 都会让
 * send_group_forward_msg 整条失败（retcode 100）。这里下载失败就省略那张头像，
 * 文字和链接照发，绝不让一张头像拖垮整条转发。
 */
export interface RankForwardOptions {
  /** 是否带头像（默认 true）。转发被平台拒绝时可以用 false 重试一次纯文字转发。 */
  avatars?: boolean
  /** 单张头像的下载超时（毫秒）。 */
  avatarTimeoutMs?: number
  /** 单张头像的大小上限（字节）。 */
  avatarMaxBytes?: number
}

const AVATAR_TIMEOUT_MS = 8000
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export async function buildRankForward(groups: RankGroup[], options: RankForwardOptions = {}): Promise<any> {
  const avatars = await loadAvatars(groups, options)

  const nodes = groups.map(({ category, rows }) => {
    const children: any[] = [h.text(`🏆 ${category.title}（${rows.length}）`)]
    rows.forEach((row, index) => {
      children.push(h.text(`\n\n${personText(row, index)}`))
      const bytes = avatarBytes(avatars, row)
      if (bytes) children.push(h.text('\n'), h.image(bytes, sniffMime(bytes)))
      children.push(h.text(`\n${profileUrl(row.handle)}`))
    })
    return h('message', { userId: '10000', nickname: category.title }, children)
  })
  return h('message', { forward: true }, nodes)
}

/**
 * 转发套转发：外层合并转发里每个分类一个节点，分类节点的 content 又是一层转发
 * （里面 5 个人各一个节点）。SnowLuma / NapCat 会把「content 全是 node」的节点
 * 识别成内层转发，深度上限 3。
 *
 * Koishi 的 OneBot 适配器不支持嵌套（会把内层转发拆成独立消息），所以这里返回
 * OneBot 原始 node 段，调用方必须直接走 bot.internal.sendGroupForwardMsg。
 */
export async function buildNestedRankNodes(groups: RankGroup[], options: RankForwardOptions = {}): Promise<any[]> {
  const avatars = await loadAvatars(groups, options)
  return groups.map(({ category, rows }) => ({
    type: 'node',
    data: {
      user_id: '10000',
      nickname: category.title,
      content: rows.map((row, index) => ({
        type: 'node',
        data: {
          user_id: '10000',
          nickname: row.displayName || row.handle,
          content: personSegments(row, index, avatars)
        }
      }))
    }
  }))
}

/** 下载头像：同一个 URL 只下载一次，失败记 null。 */
async function loadAvatars(groups: RankGroup[], options: RankForwardOptions): Promise<Map<string, Buffer | null>> {
  const timeoutMs = Math.max(1000, Number(options.avatarTimeoutMs) || AVATAR_TIMEOUT_MS)
  const maxBytes = Math.max(1024, Number(options.avatarMaxBytes) || AVATAR_MAX_BYTES)
  const withAvatars = options.avatars !== false

  const avatars = new Map<string, Buffer | null>()
  if (!withAvatars) return avatars

  // 同一个头像可能在多个分类里重复出现，只下载一次。
  const urls = new Set<string>()
  for (const { rows } of groups) {
    for (const row of rows) {
      const url = avatarOf(row.avatarUrl)
      if (url) urls.add(url)
    }
  }
  await Promise.all([...urls].map(async (url) => {
    avatars.set(url, await fetchAvatar(url, timeoutMs, maxBytes))
  }))
  return avatars
}

function personText(row: RankEntry, index: number): string {
  return `${index + 1}. ${row.displayName || row.handle}\n@${row.handle} · ${row.score}/200 ${scoreTier(row.score).icon}`
}

function avatarBytes(avatars: Map<string, Buffer | null>, row: RankEntry): Buffer | null {
  const url = avatarOf(row.avatarUrl)
  return url ? avatars.get(url) ?? null : null
}

/** 内层转发的原始 OneBot 段（不能混 koishi 元素，必须直接发给适配器）。 */
function personSegments(row: RankEntry, index: number, avatars: Map<string, Buffer | null>): any[] {
  const segments: any[] = [{ type: 'text', data: { text: personText(row, index) } }]
  const bytes = avatarBytes(avatars, row)
  if (bytes) {
    segments.push({ type: 'image', data: { file: `base64://${bytes.toString('base64')}`, cache: 0 } })
  }
  segments.push({ type: 'text', data: { text: `\n${profileUrl(row.handle)}` } })
  return segments
}

/** 下载头像；任何失败（网络、超时、非图片、太大）都返回 null，调用方直接跳过头像。 */
async function fetchAvatar(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        accept: 'image/*,*/*;q=0.8'
      }
    })
    if (!response.ok) return null
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > maxBytes) return null
    if (!looksLikeImageBuffer(bytes)) return null
    return bytes
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 合并转发不可用时的回退：纯文字榜单。 */
export function formatRankText(groups: RankGroup[]): string {
  const lines: string[] = ['🏆 烧鸡榜']
  for (const { category, rows } of groups) {
    lines.push('', `【${category.title}】`)
    if (!rows.length) {
      lines.push('暂无数据')
      continue
    }
    rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.displayName || row.handle} @${row.handle} · ${row.score}/200`)
      lines.push(`   ${profileUrl(row.handle)}`)
    })
  }
  return lines.join('\n')
}

function avatarOf(value: string | null): string | null {
  const url = String(value ?? '').trim()
  return /^https?:\/\//i.test(url) ? url : null
}

/** 引文压成一行、去掉换行，太长截断。 */
function quoteOf(examples: string[] | undefined): string {
  const first = (examples ?? []).find((item) => typeof item === 'string' && item.trim())
  if (!first) return ''
  const text = first.replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function trimLines(lines: string[], max: number): string {
  const text = lines.join('\n')
  if (text.length <= max) return text
  const out = [...lines]
  while (out.length > 1 && out.join('\n').length > max) {
    const detailIndex = out.findIndex((line) => line.startsWith('📝 '))
    if (detailIndex >= 0) {
      out.splice(detailIndex, 1)
      continue
    }
    out.pop()
  }
  const result = out.join('\n')
  return result.length > max ? `${result.slice(0, max - 1)}…` : result
}
