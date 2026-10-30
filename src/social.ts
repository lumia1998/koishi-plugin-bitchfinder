/**
 * fxTwitter 公共接口：读取 X 账号的粉丝数（无需任何 key）。
 *
 * 用途：多个候选账号无法确定谁是作者时，取已取得粉丝数中最多
 * 的一个作为最终展示（仅用于候选排序，不作为同图证明）。
 */

import { HttpClient } from './http'

export async function fetchFollowers(
  http: HttpClient,
  handles: string[],
  options: { timeout?: number; proxy?: string } = {},
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const handle of handles.slice(0, 6)) {
    try {
      const data: any = await http.getJson(
        `https://api.fxtwitter.com/${encodeURIComponent(handle)}`,
        { timeout: options.timeout ?? 10, proxy: options.proxy },
      )
      const followers = data?.user?.followers
      out[handle.toLowerCase()] =
        typeof followers === 'number' && Number.isFinite(followers) ? followers : null
    } catch {
      out[handle.toLowerCase()] = null
    }
  }
  return out
}

/** 在候选中选粉丝数最多的；数量缺失或并列时按 fallbackOrder。 */
export function pickByFollowers(
  candidates: string[],
  followers: Record<string, number | null>,
  fallbackOrder: string[],
): string {
  const known = candidates
    .map((h) => ({ handle: h.toLowerCase(), followers: followers[h.toLowerCase()] }))
    .filter((item) => item.followers !== null && item.followers !== undefined)

  if (known.length) {
    const max = Math.max(...known.map((item) => item.followers as number))
    const winners = known.filter((item) => item.followers === max)
    if (winners.length === 1) return winners[0].handle
  }
  const lowerCandidates = new Set(candidates.map((h) => h.toLowerCase()))
  for (const h of fallbackOrder) {
    if (lowerCandidates.has(h.toLowerCase())) return h
  }
  return candidates[0]
}
