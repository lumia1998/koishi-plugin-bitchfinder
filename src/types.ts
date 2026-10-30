/** 多引擎反搜的通用候选结构。字段语义与 AstrBot 原版一致。 */
export interface PostCandidate {
  /** yandex / saucenao / ascii2d / gcv / baidu / copyseeker / gcl */
  engine: string
  /** 出处页面（帖子或镜像页） */
  pageUrl: string
  title?: string
  /** 不含 @ */
  authorHandle?: string
  /** X/Twitter / Pixiv / ... */
  authorPlatform?: string
  /** 明确的原帖 URL（区别于镜像页） */
  postUrl?: string
  /** 正文摘要（供二次署名提取） */
  description?: string
  /** 候选原图 */
  imageUrl?: string
  /** 引擎内部证据权重（融合前） */
  weight?: number
}

/** 引擎级失败（调用方捕获后降级）。 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineError'
  }
}
