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
  formatVerdicts,
  fuse,
} from './fuse'
import { analyzeWithModel } from './llm'
import { hashSimilarity, perceptualHashes, prepareImage } from './preprocess'
import { fetchFollowers, pickByFollowers } from './social'
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

/** 从 Yandex 结果页 URL 中解出 Yandex 托管的公网原图 URL。 */
function extractPublicUrl(yandexResultUrl: string): string {
  const m = yandexResultUrl.match(/[?&]url=(https[^&]+)/)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1])
  } catch {
    return ''
  }
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

  // 1) 先做 Yandex 上传，拿到公网可访问的原图 URL（供 SauceNAO/GCL 用）
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
  const publicImageUrl = yandexUrl ? extractPublicUrl(yandexUrl) : ''

  // 2) 其余引擎并发；单引擎失败不影响其他引擎
  const tasks: Array<{ name: string; promise: Promise<PostCandidate[]> }> = []
  if (cfg.keylessGoogleLens) {
    // 免 Key Lens 直接吃图片 Buffer，不依赖 Yandex 是否成功
    tasks.push({
      name: 'lens',
      promise: searchGoogleLensFree(deps.http, image, {
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }
  if (cfg.saucenaoApiKey && publicImageUrl) {
    tasks.push({
      name: 'saucenao',
      promise: searchSaucenao(deps.http, publicImageUrl, {
        apiKey: cfg.saucenaoApiKey,
        timeout: cfg.timeout,
        proxy: cfg.proxy,
      }),
    })
  }
  if (cfg.serpapiApiKey && publicImageUrl) {
    tasks.push({
      name: 'gcl',
      promise: searchGoogleLens(deps.http, publicImageUrl, {
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
  const strong = verdicts.filter((v) => v.confidence >= STRONG_CONFIDENCE)

  // 5) 粉丝数 tie-break：最优先两名置信度并列且都是 X 账号时取粉丝多者
  if (cfg.followerTiebreak && strong.length >= 2) {
    const top2 = strong.slice(0, 2)
    if (
      top2[0].confidence === top2[1].confidence &&
      top2.every((v) => v.platform === 'X/Twitter')
    ) {
      const handles = top2.map((v) => v.handle)
      const followers = await fetchFollowers(deps.http, handles, {
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

  // 7) 附 Yandex 出处列表（兜底人工排查）
  const topPages = candidates
    .filter((c) => c.engine === 'yandex')
    .slice(0, cfg.maxResults)
    .map((c) => c.pageUrl)
  if (topPages.length) {
    const lines = [`Yandex 出处（前 ${topPages.length} 条）：`]
    topPages.forEach((url, index) => lines.push(`${index + 1}. ${url}`))
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
