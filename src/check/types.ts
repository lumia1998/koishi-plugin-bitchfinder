// X/Twitter 账号鉴定的公共类型。
export type Gender = 'female' | 'male' | 'unknown'

/** 一次 AI 鉴定的结果（也是榜单条目的内容）。 */
export interface CheckResult {
  /** 小写、不带 @ 的用户名 */
  handle: string
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  detail: string
  /** 0–200 */
  score: number
  complaints: number
  positives: number
  /** 第三方推文原文（已过滤自称/反问，单条不超过 300 字） */
  complaintExamples: string[]
  positiveExamples: string[]
  /** stolen_photo / fake_gender / scam / impersonation */
  riskTags: string[]
  /** recommended / verified_real / praised / trusted */
  positiveTags: string[]
  /** 风俗业者 / 可线下 / 有门槛费 / AV女优 / 福利博主 */
  accountTags: string[]
  contentTags: string[]
  activeCities: string[]
  language: string | null
  gender: Gender
  isWelfare: boolean
  followers: number | null
  tweets: number | null
  accountAgeYears: number | null
  isVerified: boolean | null
}

/** 榜单条目：本机记录和 flj.info 接口共用这几个字段。 */
export interface RankEntry {
  handle: string
  displayName: string | null
  score: number
  avatarUrl: string | null
}

/** 数据库里的一行。 */
export interface AccountRow extends CheckResult {
  id: number
  createdAt: Date
  updatedAt: Date
  searchedAt: Date
  searchCount: number
}
