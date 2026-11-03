// 可信度评分：移植自 FLJopen 的 calcScore（0–200），字段缺失时按「未知不加不减」处理。
import type { CheckResult } from './types'

export interface ScoreInput {
  accountAgeYears?: number | null
  followers?: number | null
  tweets?: number | null
  isVerified?: boolean | null
  isActive?: boolean | null
  engagement?: string | null
  positives?: number
  complaints?: number
  complaintTypes?: string[]
  usingProxy?: boolean | null
  pinnedTweetHasUrl?: boolean | null
  manualVerified?: boolean
}

export function calcScore(input: ScoreInput): number {
  let score = 20 // 账号存在即起点

  // 账号寿命：每年 +3，上限 25
  const age = numberOrNull(input.accountAgeYears)
  if (age != null) {
    if (age < 0.25) score -= 5
    else if (age < 0.5) score += 2
    else if (age < 1) score += 4
    else score += Math.min(25, Math.floor(age) * 3)
  }

  // 粉丝数：对数平滑，上限 20（100 粉 0 分，10k 粉 10 分）
  const followers = numberOrNull(input.followers)
  if (followers != null && followers > 0) {
    const value = (Math.log10(Math.max(1, followers)) - 2) * 5
    score += Math.min(20, Math.max(0, Math.round(value)))
  }

  // 发帖量：对数平滑，上限 8
  const tweets = numberOrNull(input.tweets)
  if (tweets != null && tweets > 0) {
    const value = (Math.log10(Math.max(1, tweets)) - 1.5) * 4
    score += Math.min(8, Math.max(0, Math.round(value)))
  }

  if (input.isVerified === true) score += 10
  if (input.isActive === true) score += 5
  if (input.engagement === 'high') score += 8
  else if (input.engagement === 'medium') score += 4

  if ((input.positives ?? 0) > 0) score += 10

  if ((input.complaints ?? 0) > 0) {
    score -= 8
    const types = input.complaintTypes ?? []
    if (types.includes('scam')) score -= 20
    if (types.includes('impersonation')) score -= 20
  }

  if (input.usingProxy === true) score -= 5
  if (input.pinnedTweetHasUrl === true) score -= 10
  if (input.manualVerified === true) score += 30

  return Math.max(0, Math.min(200, Math.round(score)))
}

/** 分档，报告里用来给「85/200」配一句人话。 */
export function scoreTier(score: number): { label: string; icon: string } {
  if (score >= 150) return { label: '很高', icon: '🟢' }
  if (score >= 100) return { label: '较高', icon: '🟢' }
  if (score >= 60) return { label: '一般', icon: '🟡' }
  if (score >= 30) return { label: '偏低', icon: '🟠' }
  return { label: '高危', icon: '🔴' }
}

export function riskLabel(tag: string): string {
  return ({
    stolen_photo: '盗图',
    fake_gender: '皮下男/性别不符',
    scam: '骗钱跑路',
    impersonation: '冒充他人'
  } as Record<string, string>)[tag] || tag
}

export function positiveLabel(tag: string): string {
  return ({
    recommended: '有人推荐',
    verified_real: '真人已验证',
    praised: '好评',
    trusted: '可信'
  } as Record<string, string>)[tag] || tag
}

export function resultTags(result: Pick<CheckResult, 'accountTags' | 'contentTags' | 'activeCities'>): string[] {
  return [
    ...(result.accountTags ?? []),
    ...(result.contentTags ?? []),
    ...(result.activeCities ?? [])
  ].filter(Boolean)
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
