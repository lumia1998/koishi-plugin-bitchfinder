/**
 * 反搜主流程：Yandex 首发 → 其余引擎并发 → 感知哈希确认 → 融合评分
 * → 粉丝数 tie-break → LLM 文字候选兜底 → 策展式输出。
 */

import { HttpClient } from './http'
import {
  searchAscii2d,
  searchGcv,
  searchGoogleLens,
  searchGoogleLensFree,
  searchSaucenao,
  searchYandex,
} from './engines'
import {
  AuthorVerdict,
  DESC_CREDIT_RE,
  STRONG_CONFIDENCE,
  TITLE_HANDLE_RE,
  X_URL_RE,
  cleanHandle,
  domainRoot,
  formatVerdicts,
  fuse,
  nameMatchDomains,
  textMentions,
} from './fuse'
import { analyzeWithModel } from './llm'
import { hashSimilarity, perceptualHashes, prepareImage } from './preprocess'
import { fetchFollowers, fetchProfiles, pickByFollowers } from './social'
import { PostCandidate } from './types'

export interface SearchConfig {
  maxResults: number
  timeout: number
  proxy: string
  saucenaoApiKey: string
  gcvApiKey: string
  /** ascii2d 请求模式：default 不携带 cookie（与 flj_finder 一致），cookie 携带 cf_clearance */
  ascii2dMode: 'default' | 'cookie'
  ascii2dCookie: string
  serpapiApiKey: string
  serpapiVisualMatches: boolean
  /** 免 Key Google Lens，直接上传图片解析结果页（不依赖 Yandex 公网图 URL） */
  keylessGoogleLens: boolean
  /** 通过 fxTwitter 核实候选 X 账号的资料页（昵称/粉丝），无需 key */
  verifyXProfile: boolean
  useLlmCandidates: boolean
  followerTiebreak: boolean
}

export interface SearchDeps {
  http: HttpClient
  log: (message: string) => void
  warn: (message: string) => void
  /** 返回当前可用的 ChatLuna 模型（可能为 undefined）。 */
  getModel: () => any
}

async function phashVerifyAll(
  deps: SearchDeps,
  cfg: SearchConfig,
  candidates: PostCandidate[],
  query: Buffer,
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {}
  const queryHash = await perceptualHashes(query)
  if (!queryHash) return scores

  const perHandle = new Map<string, string[]>()
  for (const c of candidates) {
    if (!c.imageUrl) continue
    const handles = new Set<string>()
    if (c.authorHandle) handles.add(c.authorHandle.toLowerCase())
    for (const m of (c.description || '').matchAll(DESC_CREDIT_RE)) {
      const h = cleanHandle(m[1] || m[2])
      if (h) handles.add(h.toLowerCase())
    }
    const tm = (c.title || '').match(TITLE_HANDLE_RE) || (c.pageUrl || '').match(X_URL_RE)
    if (tm) {
      const h = cleanHandle(tm[1])
      if (h) handles.add(h.toLowerCase())
    }
    for (const h of handles) {
      const list = perHandle.get(h) || []
      list.push(c.imageUrl)
      perHandle.set(h, list)
    }
  }
  if (!perHandle.size) return scores

  for (const [handle, urls] of perHandle) {
    for (const url of urls.slice(0, 3)) {
      let candidateHash
      try {
        const data = await deps.http.getBuffer(url, {
          timeout: cfg.timeout,
          proxy: cfg.proxy,
        })
        candidateHash = await perceptualHashes(data)
      } catch {
        continue
      }
      if (!candidateHash) continue
      const sim = hashSimilarity(queryHash, candidateHash)
      if (sim > (scores[handle] || 0)) scores[handle] = sim
    }
  }
  return scores
}

/**
 * 用 fxTwitter 公开资料页核实候选账号：
 * - 昵称出现在多个出处页文字中 → 说明页面署名与该账号是同一人，加分；
 * - 资料页存在且候选有跨站一致署名 → 把"站内人名"升级为 X 账号。
 */
async function verifyXProfiles(
  deps: SearchDeps,
  cfg: SearchConfig,
  candidates: PostCandidate[],
  verdicts: AuthorVerdict[],
): Promise<AuthorVerdict[]> {
  const targets = verdicts
    .filter((v) => v.confidence >= 0.1 && /^[A-Za-z0-9_]{2,20}$/.test(v.handle))
    .slice(0, 5)
  if (!targets.length) return verdicts

  const profiles = await fetchProfiles(
    deps.http,
    targets.map((v) => v.handle),
    { timeout: Math.min(cfg.timeout, 10), proxy: cfg.proxy },
  )

  for (const v of targets) {
    const p = profiles.get(v.handle.toLowerCase())
    if (!p) continue
    v.profileName = p.name || undefined
    v.followers = p.followers
    v.profileVerified = true
    // 以资料页的真实大小写展示（出处页常把 handle 写成小写）
    if (p.handle) v.handle = p.handle

    const nameDomains = nameMatchDomains(candidates, p.name)
    const nameOk = nameDomains.size > 0
    if (nameOk && (nameDomains.size >= 2 || v.domains.size >= 2)) {
      v.confidence = Math.min(
        1,
        v.confidence + (nameDomains.size >= 3 ? 0.2 : 0.15),
      )
      v.evidence.push(
        `X 资料页昵称“${p.name}”与 ${nameDomains.size} 个出处页文字一致`,
      )
    }
    if (v.platform !== 'X/Twitter' && (nameOk || v.domains.size >= 3)) {
      v.platform = 'X/Twitter'
      v.evidence.push(`fxTwitter 资料页确认: @${p.handle}`)
    }
    deps.log(
      `X 资料页 @${p.handle}: ${p.name}${p.followers !== null ? ` / ${p.followers} fans` : ''}`,
    )
  }

  return verdicts.sort((a, b) => b.confidence - a.confidence)
}

interface RankedPage {
  url: string
  score: number
  label: string
}

/**
 * 按可信度排序出处页：与强候选同域且文字署名的页面排最前，
 * 其次是文字提及该账号的页面，其余按 Yandex 原始顺序。
 */
function rankYandexPages(
  candidates: PostCandidate[],
  verdicts: AuthorVerdict[],
  limit: number,
): RankedPage[] {
  const strong = verdicts.filter((v) => v.confidence >= STRONG_CONFIDENCE)
  const scored = candidates
    .filter((c) => c.engine === 'yandex' && c.pageUrl)
    .map((c, index) => {
      const root = domainRoot(c.pageUrl)
      const text = `${c.title || ''} ${c.description || ''}`
      let score = 0
      let label = ''
      for (const v of strong) {
        const inDomain = v.domains.has(root)
        const mention =
          textMentions(text, v.handle) || textMentions(c.pageUrl, v.handle)
        if (!inDomain && !mention) continue
        const value = v.confidence + (inDomain && mention ? 0.15 : 0)
        if (value > score) {
          score = value
          label = inDomain && mention
            ? `含 @${v.handle} 署名`
            : inDomain
              ? `@${v.handle} 出处站`
              : `提及 @${v.handle}`
        }
      }
      return { url: c.pageUrl, score, label, index }
    })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const out: RankedPage[] = []
  const seen = new Set<string>()
  for (const p of scored) {
    if (seen.has(p.url)) continue
    seen.add(p.url)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

function formatLlmCandidates(cands: Awaited<ReturnType<typeof analyzeWithModel>>): string {
  const lines = ['LLM 文字线索（待核实，仅提取来源页中出现过的标识）：']
  for (const c of cands) {
    const plat = c.platform !== 'unknown' ? `[${c.platform}]` : ''
    lines.push(`  ? @${c.handle} ${plat}  依据: “…${c.evidence.slice(0, 60)}…”`)
    if (c.platform === 'X/Twitter') {
      lines.push(`      X 搜索验证: https://x.com/search?q=from%3A${c.handle}`)
    }
  }
  return lines.join('\n')
}

export async function reverseSearch(
  imageInput: Buffer,
  cfg: SearchConfig,
  deps: SearchDeps,
): Promise<string> {
  const image = await prepareImage(imageInput)
  const candidates: PostCandidate[] = []
  const engineErrors: Record<string, string> = {}
  let yandexUrl = ''

  // 1) 先做 Yandex 上传（主索引 + 结果页链接）；失败不影响其他引擎
  try {
    const yandex = await searchYandex(deps.http, image, {
      timeout: cfg.timeout,
      proxy: cfg.proxy,
    })
    yandexUrl = yandex.resultUrl
    candidates.push(...yandex.candidates)
  } catch (err) {
    engineErrors.yandex = String(err)
    deps.warn(`yandex 失败: ${String(err)}`)
  }

  // 2) 其余引擎并发；每个引擎都直接吃图片字节，互不依赖
  const tasks: Array<{ name: string; promise: Promise<PostCandidate[]> }> = []
  if (cfg.keylessGoogleLens) {
    tasks.push({
      name: 'lens',
      promise: searchGoogleLensFree(deps.http, image, {
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }
  if (cfg.saucenaoApiKey) {
    // SauceNAO 支持 multipart 直传，不再借道 Yandex 图床
    tasks.push({
      name: 'saucenao',
      promise: searchSaucenao(deps.http, image, {
        apiKey: cfg.saucenaoApiKey,
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }
  if (cfg.serpapiApiKey) {
    // SerpApi 走 Image API 上传拿 image_id，同样不依赖 Yandex
    tasks.push({
      name: 'gcl',
      promise: searchGoogleLens(deps.http, image, {
        apiKey: cfg.serpapiApiKey,
        visualMatches: cfg.serpapiVisualMatches,
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }
  if (cfg.ascii2dMode === 'cookie' && !cfg.ascii2dCookie) {
    deps.warn('ascii2d 已设为 cookie 模式但未填写 cf_clearance，本次按无 cookie 请求')
  }
  tasks.push({
    name: 'ascii2d',
    promise: searchAscii2d(deps.http, image, {
      timeout: cfg.timeout,
      proxy: cfg.proxy,
      cfClearance: cfg.ascii2dMode === 'cookie' ? cfg.ascii2dCookie : '',
    }),
  })
  if (cfg.gcvApiKey) {
    tasks.push({
      name: 'gcv',
      promise: searchGcv(deps.http, image, {
        apiKey: cfg.gcvApiKey,
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }

  const results = await Promise.allSettled(tasks.map((task) => task.promise))
  results.forEach((result, index) => {
    const name = tasks[index].name
    if (result.status === 'rejected') {
      const reason = String(result.reason)
      // 默认模式下 ascii2d 被 CF 拦截属于已知情况，只在日志里提示，不污染结果
      if (cfg.ascii2dMode === 'default' && name === 'ascii2d') {
        deps.warn(`${name} 失败: ${reason}`)
      } else {
        engineErrors[name] = reason
        deps.warn(`${name} 失败: ${reason}`)
      }
    } else {
      deps.log(`${name}: ${result.value.length} 条`)
      candidates.push(...result.value)
    }
  })

  if (!candidates.length) {
    let message = '本次检索未取得任何结果。'
    if (Object.keys(engineErrors).length) {
      message +=
        '\n各引擎状态：' +
        Object.entries(engineErrors)
          .map(([k, v]) => `${k}: ${v}`)
          .join('；')
    }
    message += '\n提示：引擎被风控/验证页拦截不等于图片没有出处，可稍后重试。'
    if (yandexUrl) message += `\nYandex 结果页: ${yandexUrl}`
    return message
  }

  // 3) 感知哈希硬确认（同图加成）
  const phashScores = await phashVerifyAll(deps, cfg, candidates, image)

  // 4) 融合评分
  let verdicts: AuthorVerdict[] = fuse(candidates, phashScores)

  // 4.5) X 资料页核实（昵称一致性 → 认定同一人；也可把站内人名升级为 X 账号）
  if (cfg.verifyXProfile) {
    verdicts = await verifyXProfiles(deps, cfg, candidates, verdicts)
  }
  const strong = verdicts.filter((v) => v.confidence >= STRONG_CONFIDENCE)

  // 5) 粉丝数 tie-break：最优先两名置信度并列且都是 X 账号时取粉丝多者
  if (cfg.followerTiebreak && strong.length >= 2) {
    const top2 = strong.slice(0, 2)
    if (
      top2[0].confidence === top2[1].confidence &&
      top2.every((v) => v.platform === 'X/Twitter')
    ) {
      const handles = top2.map((v) => v.handle)
      const cached = top2.every((v) => typeof v.followers === 'number')
      const followers = cached
        ? Object.fromEntries(top2.map((v) => [v.handle.toLowerCase(), v.followers as number]))
        : await fetchFollowers(deps.http, handles, {
            timeout: 10,
            proxy: cfg.proxy,
          })
      const winner = pickByFollowers(handles, followers, handles)
      deps.log(`粉丝 tie-break: ${JSON.stringify(followers)} -> @${winner}`)
      if (winner.toLowerCase() === handles[1].toLowerCase()) {
        const firstIndex = verdicts.indexOf(top2[0])
        verdicts = verdicts.filter((v) => v !== top2[1])
        verdicts.splice(firstIndex, 0, top2[1])
      }
    }
  }

  let text = formatVerdicts(verdicts, cfg.maxResults)

  // 6) LLM 文字候选兜底：无可靠署名时从来源文字提取账号线索
  if (cfg.useLlmCandidates && !strong.length) {
    const model = deps.getModel()
    if (model) {
      const llmCandidates = await analyzeWithModel(model, candidates)
      if (llmCandidates.length) {
        text += '\n' + formatLlmCandidates(llmCandidates)
      }
    }
  }

  // 7) 附 Yandex 出处列表，按与强候选的关联度排序
  const topPages = rankYandexPages(candidates, verdicts, cfg.maxResults)
  if (topPages.length) {
    const lines = [`Yandex 出处（按可信度排序，前 ${topPages.length} 条）：`]
    topPages.forEach((p, index) =>
      lines.push(`${index + 1}. ${p.url}${p.label ? `  [${p.label}]` : ''}`),
    )
    text += '\n' + lines.join('\n')
  }

  // 部分引擎失败时附状态，帮助区分"无署名"与"引擎被拦"
  if (Object.keys(engineErrors).length) {
    text +=
      '\n引擎状态：' +
      Object.entries(engineErrors)
        .map(([k, v]) => `${k}: ${v}`)
        .join('；')
  }
  if (yandexUrl) text += `\n完整结果页：${yandexUrl}`

  return text
}
