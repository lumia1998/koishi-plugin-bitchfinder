// 鉴定服务：缓存 → 限流 → 调 xAI → 落库。
import type { Logger } from 'koishi'
import { AiError, checkAccount, normalizeHandle } from './ai'
import type { AiOptions } from './ai'
import type { AccountStore } from './store'
import type { AccountRow } from './types'

export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}

export interface VerifierOptions extends AiOptions {
  logger: Logger
  store: AccountStore
  cooldownSec: number
  dailyLimit: number
  cacheHours: number
}

export interface VerifyOutcome {
  row: AccountRow
  cached: boolean
  /** 调 AI 失败，返回的是过期旧数据。 */
  stale?: boolean
}

export class Verifier {
  private lastUse = new Map<string, number>()
  private daily = new Map<string, { day: string; count: number }>()
  private inFlight = new Map<string, Promise<VerifyOutcome>>()

  constructor(private options: VerifierOptions) {}

  /** 只验用户名，不调 AI（工具里先检查参数用）。 */
  normalize(raw: string): string {
    const handle = normalizeHandle(raw)
    if (!handle) throw new UserError('用户名不对：发 @用户名，或者 https://x.com/用户名。')
    return handle
  }

  async check(rawHandle: string, sessionKey?: string): Promise<VerifyOutcome> {
    const handle = this.normalize(rawHandle)
    const { store, logger } = this.options

    const cached = await store.get(handle)
    if (cached && store.isFresh(cached)) return { row: cached, cached: true }

    const running = this.inFlight.get(handle)
    if (running) return running

    const key = String(sessionKey ?? 'local')
    this.assertLimit(key)

    const task = (async (): Promise<VerifyOutcome> => {
      this.consume(key)
      try {
        const result = await checkAccount(handle, this.options)
        const row = await store.save(result)
        return { row, cached: false }
      } catch (error) {
        if (cached) {
          logger.warn('鉴定 @%s 失败，先用旧数据：%s', handle, (error as Error)?.message ?? error)
          return { row: cached, cached: true, stale: true }
        }
        throw this.mapError(error)
      }
    })()

    this.inFlight.set(handle, task)
    try {
      return await task
    } finally {
      this.inFlight.delete(handle)
    }
  }

  private assertLimit(key: string) {
    const gap = Math.max(0, Number(this.options.cooldownSec) || 0) * 1000
    const last = this.lastUse.get(key) ?? 0
    if (gap && Date.now() - last < gap) {
      throw new UserError(`刚鉴定过，${Math.ceil((gap - (Date.now() - last)) / 1000)} 秒后再试。`)
    }

    const limit = Math.max(0, Number(this.options.dailyLimit) || 0)
    if (!limit) return
    const today = dayKey()
    const record = this.daily.get(key)
    if (record?.day === today && record.count >= limit) {
      throw new UserError(`今天已经鉴定 ${limit} 次了，明天再来（xAI 按量收费，省着点用）。`)
    }
  }

  private consume(key: string) {
    this.lastUse.set(key, Date.now())
    const today = dayKey()
    const record = this.daily.get(key)
    if (record?.day === today) record.count += 1
    else this.daily.set(key, { day: today, count: 1 })
    // 防止 Map 无限长：顺手清掉昨天的记录
    if (this.daily.size > 500) {
      for (const [k, v] of this.daily) if (v.day !== today) this.daily.delete(k)
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof UserError || error instanceof AiError) return error
    return new Error(`鉴定失败：${(error as Error)?.message ?? error}`)
  }
}

function dayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}
