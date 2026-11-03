// 烧鸡榜：把库里鉴定过的账号按分类挑前 N 个。
import type { AccountRow } from './types'

export interface RankCategory {
  key: string
  title: string
  /** 用户输入这些词也能命中（大小写不敏感）。 */
  aliases: string[]
  filter(row: AccountRow): boolean
  compare(a: AccountRow, b: AccountRow): number
}

const byTime = (a: AccountRow, b: AccountRow) => time(b.searchedAt) - time(a.searchedAt)
const byScore = (a: AccountRow, b: AccountRow) => b.score - a.score || b.positives - a.positives || byTime(a, b)
const byComplaint = (a: AccountRow, b: AccountRow) =>
  b.complaints - a.complaints || b.riskTags.length - a.riskTags.length || byTime(a, b)

const hasTag = (tag: string) => (row: AccountRow) => row.accountTags.includes(tag)

const JAPAN_CITY = /東京|大阪|京都|神戸|名古屋|福岡|札幌|仙台|横浜|埼玉|千葉|長野|沖縄/

function isJapanese(row: AccountRow): boolean {
  const language = String(row.language ?? '').toLowerCase()
  if (/日本|日文|日語|日语|japan|jp/.test(language)) return true
  return row.activeCities.some((city) => JAPAN_CITY.test(city))
}

export const RANK_CATEGORIES: RankCategory[] = [
  {
    key: 'latest',
    title: '最新爆料',
    aliases: ['最新爆料', '爆料', '最新', 'latest'],
    filter: (row) => row.complaints > 0 || row.riskTags.length > 0,
    compare: byComplaint
  },
  {
    key: 'recent',
    title: '最新检索',
    aliases: ['最新检索', '最新檢索', '最近检索', '最近', 'recent'],
    filter: () => true,
    compare: byTime
  },
  {
    key: 'top',
    title: '评分最高',
    aliases: ['评分最高', '評分最高', '最高分', '评分', 'top', 'score'],
    filter: () => true,
    compare: byScore
  },
  {
    key: 'fushi',
    title: '风俗业者',
    aliases: ['风俗业者', '風俗業者', '风俗', '風俗', 'fushi'],
    filter: hasTag('风俗业者'),
    compare: byScore
  },
  {
    key: 'threshold',
    title: '门槛妹',
    aliases: ['门槛妹', '門檻妹', '门槛', '門檻', '有门槛费', 'threshold'],
    filter: hasTag('有门槛费'),
    compare: byScore
  },
  {
    key: 'av',
    title: 'AV女优',
    aliases: ['AV女优', 'AV女優', 'av', '女优', '女優'],
    filter: hasTag('AV女优'),
    compare: byScore
  },
  {
    key: 'welfare',
    title: '福利博主',
    aliases: ['福利博主', '福利', '图包博主', '圖包博主', 'welfare'],
    filter: hasTag('福利博主'),
    compare: byScore
  },
  {
    key: 'japan',
    title: 'JP 日文区',
    aliases: ['jp', 'japan', '日文区', '日文區', '日本', '日区', '日區'],
    filter: isJapanese,
    compare: byScore
  },
  {
    key: 'scam',
    title: '诈骗预警',
    aliases: ['诈骗预警', '詐騙預警', '诈骗', '詐騙', '差评', '避雷', 'scam', 'warning'],
    filter: (row) => row.riskTags.includes('scam') || row.riskTags.includes('impersonation'),
    compare: byComplaint
  }
]

export function resolveCategory(input?: string | null): RankCategory | null {
  const text = String(input ?? '').trim().toLowerCase()
  if (!text) return null
  return RANK_CATEGORIES.find((category) =>
    category.key === text || category.aliases.some((alias) => alias.toLowerCase() === text)
  ) ?? RANK_CATEGORIES.find((category) =>
    category.title.toLowerCase().includes(text) || category.aliases.some((alias) => alias.toLowerCase().includes(text))
  ) ?? null
}

export function pickTop(rows: AccountRow[], category: RankCategory, size: number): AccountRow[] {
  const limit = Math.max(1, Math.min(20, Number(size) || 5))
  return rows
    .filter((row) => category.filter(row))
    .sort(category.compare)
    .slice(0, limit)
}

export function buildRank(rows: AccountRow[], keys: string[], size: number): Array<{ category: RankCategory; rows: AccountRow[] }> {
  return keys
    .map((key) => RANK_CATEGORIES.find((category) => category.key === key))
    .filter((category): category is RankCategory => !!category)
    .map((category) => ({ category, rows: pickTop(rows, category, size) }))
}

function time(value: Date | string | number): number {
  const n = new Date(value).getTime()
  return Number.isFinite(n) ? n : 0
}
