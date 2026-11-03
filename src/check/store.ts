// 鉴定结果存储：优先 Koishi 数据库，没装数据库时退回进程内存（重启即丢）。
import type { Context, Logger } from 'koishi'
import type { AccountRow, CheckResult } from './types'

export const TABLE = 'bitchfinder_account'

declare module 'koishi' {
  interface Tables {
    bitchfinder_account: AccountRow
  }
}

/** 在 database 服务就绪后建表；没有 database 就不调用。 */
export function defineModel(ctx: Context) {
  ctx.model.extend(TABLE, {
    id: 'unsigned',
    handle: 'string',
    displayName: 'string',
    bio: 'text',
    avatarUrl: 'text',
    detail: 'text',
    score: 'unsigned',
    complaints: 'unsigned',
    positives: 'unsigned',
    complaintExamples: 'list',
    positiveExamples: 'list',
    riskTags: 'list',
    positiveTags: 'list',
    accountTags: 'list',
    contentTags: 'list',
    activeCities: 'list',
    language: 'string',
    gender: 'string',
    isWelfare: 'boolean',
    followers: 'float',
    tweets: 'float',
    accountAgeYears: 'float',
    isVerified: 'boolean',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
    searchedAt: 'timestamp',
    searchCount: 'unsigned'
  }, { primary: 'id', autoInc: true })
}

export interface AccountStoreOptions {
  logger: Logger
  /** 结果在这么多小时内算新鲜，直接复用不再调 AI。 */
  cacheHours: number
}

export class AccountStore {
  private memory = new Map<string, AccountRow>()
  private nextId = 1

  constructor(private ctx: Context, private options: AccountStoreOptions) {}

  get persistent() {
    return !!(this.ctx as any).database
  }

  private get database() {
    return (this.ctx as any).database
  }

  isFresh(row: AccountRow): boolean {
    const hours = Math.max(0, Number(this.options.cacheHours) || 0)
    if (!hours) return false
    const at = new Date(row.searchedAt).getTime()
    return Number.isFinite(at) && Date.now() - at < hours * 3600_000
  }

  async get(handle: string): Promise<AccountRow | null> {
    const key = handle.toLowerCase()
    const db = this.database
    if (db) {
      try {
        const rows = await db.get(TABLE, { handle: key }, { limit: 1 })
        if (rows?.length) return normalizeRow(rows[0])
        return null
      } catch (error) {
        this.options.logger.warn('读取鉴定缓存失败，改用内存：%s', (error as Error)?.message ?? error)
      }
    }
    return this.memory.get(key) ?? null
  }

  async list(): Promise<AccountRow[]> {
    const db = this.database
    if (db) {
      try {
        const rows = await db.get(TABLE, {})
        return (rows ?? []).map(normalizeRow)
      } catch (error) {
        this.options.logger.warn('读取鉴定列表失败，改用内存：%s', (error as Error)?.message ?? error)
      }
    }
    return [...this.memory.values()]
  }

  async save(result: CheckResult): Promise<AccountRow> {
    const now = new Date()
    const key = result.handle.toLowerCase()
    const existing = await this.get(key)
    const data: Omit<AccountRow, 'id'> = {
      ...result,
      handle: key,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      searchedAt: now,
      searchCount: (existing?.searchCount ?? 0) + 1
    }

    const db = this.database
    if (db) {
      try {
        if (existing) {
          await db.set(TABLE, { id: existing.id }, data)
          return { ...data, id: existing.id }
        }
        const created = await db.create(TABLE, data as any)
        const saved = normalizeRow(Array.isArray(created) ? created[0] : created)
        return saved?.id ? saved : { ...data, id: -1 }
      } catch (error) {
        this.options.logger.warn('写入鉴定缓存失败，改用内存：%s', (error as Error)?.message ?? error)
      }
    }

    const saved: AccountRow = { ...data, id: existing?.id ?? this.nextId++ }
    this.memory.set(key, saved)
    return saved
  }
}

function normalizeRow(row: any): AccountRow {
  const asList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
    if (typeof value === 'string' && value) {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
      } catch { return [] }
    }
    return []
  }
  return {
    id: Number(row.id) || 0,
    handle: String(row.handle ?? '').toLowerCase(),
    displayName: row.displayName ?? null,
    bio: row.bio ?? null,
    avatarUrl: row.avatarUrl ?? null,
    detail: row.detail ?? '',
    score: Number(row.score) || 0,
    complaints: Number(row.complaints) || 0,
    positives: Number(row.positives) || 0,
    complaintExamples: asList(row.complaintExamples),
    positiveExamples: asList(row.positiveExamples),
    riskTags: asList(row.riskTags),
    positiveTags: asList(row.positiveTags),
    accountTags: asList(row.accountTags),
    contentTags: asList(row.contentTags),
    activeCities: asList(row.activeCities),
    language: row.language ?? null,
    gender: row.gender === 'female' || row.gender === 'male' ? row.gender : 'unknown',
    isWelfare: row.isWelfare === true || row.isWelfare === 1,
    followers: nullableNumber(row.followers),
    tweets: nullableNumber(row.tweets),
    accountAgeYears: nullableNumber(row.accountAgeYears),
    isVerified: typeof row.isVerified === 'boolean'
      ? row.isVerified
      : row.isVerified === 1 ? true : row.isVerified === 0 ? false : null,
    createdAt: new Date(row.createdAt ?? Date.now()),
    updatedAt: new Date(row.updatedAt ?? Date.now()),
    searchedAt: new Date(row.searchedAt ?? row.updatedAt ?? Date.now()),
    searchCount: Number(row.searchCount) || 1
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
