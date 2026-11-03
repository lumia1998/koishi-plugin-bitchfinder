// 烧鸡榜的线上数据源：flj.info 的公开排行榜接口。
// 网站自己就有全量数据，没必要为了看榜先把每个账号都鉴定一遍。
import type { RankCategory } from './rank'
import type { RankEntry } from './types'

export class RankApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RankApiError'
  }
}

/** 同一分类在这么多毫秒内复用，避免群里连着刷榜把对方接口打爆。 */
const CACHE_TTL = 5 * 60_000

export class RankFetcher {
  private cache = new Map<string, { at: number; rows: RankEntry[] }>()
  private inflight = new Map<string, Promise<RankEntry[]>>()

  constructor(private baseUrl: string, private timeoutMs = 10_000) {}

  get enabled() {
    return !!normalizeBase(this.baseUrl)
  }

  async fetch(category: RankCategory, size: number): Promise<RankEntry[]> {
    const limit = Math.max(1, Math.min(20, Number(size) || 5))
    const key = `${category.key}:${limit}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.rows

    let pending = this.inflight.get(key)
    if (!pending) {
      pending = this.request(category, limit).finally(() => this.inflight.delete(key))
      this.inflight.set(key, pending)
    }
    const rows = await pending
    this.cache.set(key, { at: Date.now(), rows })
    return rows
  }

  private async request(category: RankCategory, limit: number): Promise<RankEntry[]> {
    const base = normalizeBase(this.baseUrl)
    if (!base) throw new RankApiError('没有配置排行榜接口')
    const url = `${base}${base.includes('?') ? '&' : '?'}category=${encodeURIComponent(category.api)}&page=1`
    const origin = originOf(base)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(3000, this.timeoutMs))
    let res: Response
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'koishi-plugin-bitchfinder'
        },
        signal: controller.signal
      })
    } catch (error) {
      if (controller.signal.aborted) throw new RankApiError('排行榜接口超时')
      throw new RankApiError(`连不上排行榜接口：${(error as Error)?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw new RankApiError(`排行榜接口返回 ${res.status}`)
    let data: any
    try {
      data = await res.json()
    } catch {
      throw new RankApiError('排行榜接口返回的不是 JSON')
    }
    const items: unknown[] = Array.isArray(data?.items) ? data.items : []
    return items
      .map((item) => toEntry(item, origin))
      .filter((entry): entry is RankEntry => !!entry)
      .slice(0, limit)
  }
}

function toEntry(item: any, origin: string): RankEntry | null {
  const handle = String(item?.twitter_username ?? '').trim()
  // 只收合法 X 用户名，防止把接口里的脏数据拼进消息
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null
  const score = Number(item?.score)
  const displayName = typeof item?.display_name === 'string' && item.display_name.trim()
    ? item.display_name.trim()
    : null
  return {
    handle: handle.toLowerCase(),
    displayName,
    score: Number.isFinite(score) ? Math.max(0, Math.min(200, score)) : 0,
    avatarUrl: absoluteUrl(item?.avatar_url, origin)
  }
}

function normalizeBase(value: string): string {
  let base = String(value ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`
  // 允许只填站点地址，自动补接口路径
  if (!/\/api\/rankings(?:$|\?)/.test(base)) base = `${base}/api/rankings`
  return base
}

function originOf(base: string): string {
  try {
    return new URL(base).origin
  } catch {
    return ''
  }
}

function absoluteUrl(value: unknown, origin: string): string | null {
  const url = String(value ?? '').trim()
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('/') && origin) return origin + url
  return null
}
