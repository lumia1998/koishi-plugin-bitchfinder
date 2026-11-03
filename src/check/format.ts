// 鉴定报告与烧鸡榜的文本 / 合并转发格式。
import { h } from 'koishi'
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
export function formatReport(row: AccountRow, options: { cached?: boolean; stale?: boolean; cacheHours?: number } = {}): string {
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
    const hours = Math.max(0, Number(options.cacheHours) || 0)
    lines.push(hours
      ? `🔁 来自缓存（${hours} 小时内不重复调 AI，再查会更新）`
      : '🔁 来自缓存（上次的结果）')
  }

  return trimLines(lines, 900)
}

/** 合并转发：每个分类一个节点，节点里按名次放头像 / 名字 / 主页。 */
export function buildRankForward(groups: RankGroup[]): any {
  const nodes = groups.map(({ category, rows }) => {
    const children: any[] = [h.text(`🏆 ${category.title}（${rows.length}）`)]
    rows.forEach((row, index) => {
      children.push(h.text(`\n\n${index + 1}. ${row.displayName || row.handle}\n@${row.handle} · ${row.score}/200 ${scoreTier(row.score).icon}`))
      const avatar = avatarOf(row.avatarUrl)
      if (avatar) children.push(h.text('\n'), h.image(avatar))
      children.push(h.text(`\n${profileUrl(row.handle)}`))
    })
    return h('message', { userId: '10000', nickname: category.title }, children)
  })
  return h('message', { forward: true }, nodes)
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
