// ── 浏览器（用 Koishi 的 puppeteer 服务，替代原版的自拉 headless Edge）─────
// 原版是单例浏览器 + 复用一个 page、一次只跑一个引擎；
// 这里换成「全局 FIFO 锁 + 每次一个新 tab」，串行语义不变。
import fs from 'node:fs'
import type { Context, Logger } from 'koishi'
import type {} from 'koishi-plugin-puppeteer'
import type { BrowserContext, CDPSession, Page } from 'puppeteer-core'
import { BROWSER_UA_CHROME, hostAllowed } from './constants'
import { hostOf, sleep } from './utils'

export const PAGE_PROFILE = {
  // 兜底 UA：正常会先用「浏览器真实 UA 去掉 Headless 字样」，读不到才用这个。
  userAgent: BROWSER_UA_CHROME,
  // Chrome 会按这个 locale 列表自己补 q 值 → 发出去正好和原版 headless Edge（--lang=zh-CN）
  // 的 accept-language 逐字节一致：zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6。
  // （代价：navigator.languages 比原版多一个 'zh'，二者不可兼得，取请求头一致。）
  acceptLanguage: 'zh-CN,zh,en,en-GB,en-US',
  // 实测原版 headless Edge 的 innerWidth/innerHeight（800x600 窗口去掉滚动条/边框）
  viewport: { width: 746, height: 436, deviceScaleFactor: 1 }
}

export interface BrowserTab {
  page: Page
  cdp: CDPSession
  /** Same contract as the original `state.send`: rejects with `CDP 超时：${method}` after 25000 ms. */
  send(method: string, params?: object): Promise<any>
}

export class FishBrowser {
  private queue: Promise<unknown> = Promise.resolve()
  private context: BrowserContext | null = null
  private webdriverWarned = false
  private logger: Logger

  constructor(private ctx: Context, private options: { proxy?: string } = {}) {
    this.logger = ctx.logger('bitchfinder')
  }

  /** Global FIFO lock (one browser task at a time, across all users/commands). */
  run<T>(fn: (tab: BrowserTab) => Promise<T>): Promise<T> {
    const task = this.queue.then(() => this.runInner(fn))
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  /** Close the dedicated proxy BrowserContext if one was created. */
  async dispose(): Promise<void> {
    const context = this.context
    this.context = null
    try { await context?.close() } catch {}
  }

  // 代理通道是浏览器 context 的属性，起来之后改不了：所以单独开一个 BrowserContext。
  private async proxyContext(): Promise<BrowserContext> {
    const browser = this.ctx.puppeteer.browser as any
    if (this.context) {
      const browserGone = !browser || browser.connected === false
      let contextGone = false
      try { contextGone = (this.context as any).closed === true } catch { contextGone = true }
      if (browserGone || contextGone) this.context = null
    }
    if (!this.context) {
      if (typeof browser?.createBrowserContext === 'function') {
        this.context = await browser.createBrowserContext({ proxyServer: this.options.proxy })
      } else {
        this.context = await browser.createIncognitoBrowserContext()
      }
    }
    return this.context!
  }

  // 读真实浏览器的 UA 和 client hints（brand/版本/平台等），把 headless 字样抹掉后回填。
  // 读不到 userAgentData（老内核或远程浏览器）就只覆盖 UA，不带 metadata。
  private async readRealProfile(tab: BrowserTab): Promise<{ userAgent: string; userAgentMetadata?: object }> {
    const fallback = { userAgent: PAGE_PROFILE.userAgent }
    try {
      const r = await tab.send('Runtime.evaluate', {
        expression: `(async () => {
          const ua = navigator.userAgent
          const d = navigator.userAgentData
          if (!d || !d.getHighEntropyValues) return { ua }
          const v = await d.getHighEntropyValues(['architecture', 'bitness', 'brands', 'fullVersionList', 'model', 'mobile', 'platform', 'platformVersion', 'uaFullVersion', 'wow64'])
          return { ua, v }
        })()`,
        returnByValue: true,
        awaitPromise: true
      })
      const ua = String(r?.result?.value?.ua ?? '')
      const userAgent = ua ? ua.replace('HeadlessChrome', 'Chrome').replace('HeadlessEdg', 'Edg') : PAGE_PROFILE.userAgent
      const v = r?.result?.value?.v
      if (!v) return { userAgent }
      const fix = (list: any[]) => (Array.isArray(list) ? list.map((e) => ({ ...e, brand: e.brand === 'HeadlessChrome' ? 'Google Chrome' : e.brand })) : list)
      return {
        userAgent,
        userAgentMetadata: {
          brands: fix(v.brands),
          fullVersion: v.uaFullVersion ?? '',
          platform: v.platform ?? 'Windows',
          platformVersion: v.platformVersion ?? '0.0.0',
          architecture: v.architecture ?? 'x86',
          model: v.model ?? '',
          mobile: v.mobile ?? false,
          bitness: v.bitness ?? '64',
          wow64: v.wow64 ?? false,
          ...(v.fullVersionList ? { fullVersionList: fix(v.fullVersionList) } : {})
        }
      }
    } catch {
      return fallback
    }
  }

  private async newPage(): Promise<Page> {
    const proxy = String(this.options.proxy ?? '')
    if (!proxy) return this.ctx.puppeteer.page()
    try {
      return await (await this.proxyContext()).newPage()
    } catch {
      // context 可能在外部被关掉了：扔掉重建一次
      this.context = null
      return (await this.proxyContext()).newPage()
    }
  }

  private async runInner<T>(fn: (tab: BrowserTab) => Promise<T>): Promise<T> {
    const page = await this.newPage()
    let cdp: CDPSession
    try {
      cdp = await page.createCDPSession()
    } catch (error) {
      try { await page.close() } catch {}
      throw error
    }
    const tab: BrowserTab = {
      page,
      cdp,
      send(method: string, params: object = {}) {
        // 页面正在跳转 / 目标进程卡死时，CDP 可能永远不回 —— 没有这个超时，
        // 一条 evaluate 就能把整个任务挂住十几分钟（真实踩过）。
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`CDP 超时：${method}`)), 25000)
          cdp.send(method as any, params as any).then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) }
          )
        })
      }
    }
    try {
      // 原版靠启动参数（--user-agent / --lang / --disable-blink-features=AutomationControlled）伪装；
      // puppeteer 用自己的 flags 启动，前两项可以在页面落地前用 CDP 补，blink 特征补不了。
      await page.setViewport(PAGE_PROFILE.viewport)
      await tab.send('Page.enable')
      // UA 和 sec-ch-ua / userAgentData 从真实浏览器读出来、只去掉 Headless 字样再回填：
      // 品牌、版本、平台全和本机真实二进制一致，比写死某个版本更不显眼，也不会过时。
      const real = await this.readRealProfile(tab)
      await tab.send('Emulation.setUserAgentOverride', {
        userAgent: real.userAgent,
        acceptLanguage: PAGE_PROFILE.acceptLanguage,
        ...(real.userAgentMetadata ? { userAgentMetadata: real.userAgentMetadata } : {})
      })
      // AutomationControlled 只能在启动参数里关。实测：页面侧 defineProperty 补丁会被
      // 谷歌识破（getter 不是 native code，3/3 全被拦），启动参数原生关掉才通过（3/3）。
      // 所以这里不补丁，只检测一次并提示用户去配 puppeteer。
      const wd = await tab.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
      if (wd?.result?.value && !this.webdriverWarned) {
        this.webdriverWarned = true
        this.logger.warn('navigator.webdriver 仍为 true：请在 koishi-plugin-puppeteer 的启动参数 args 里加 --disable-blink-features=AutomationControlled，否则 Google Lens 会被验证码拦截')
      }
      return await fn(tab)
    } finally {
      try { await cdp.detach() } catch {}
      try { await page.close() } catch {}
    }
  }
}

export interface FileUploadOptions {
  startUrl: string
  filePath: string
  fileSelector?: string
  timeoutMs?: number
  settleMs?: number
  prepareExpression?: string
  submitExpression?: string
  waitForExpression?: string
  extractExpression?: string
}

export interface FileUploadResult {
  html: string
  url: string
  data?: any
}

/**
 * 用真浏览器打开一个页面、把本地图片塞进 <input type=file>，再等结果页落地取 DOM。
 * 有些站只认「页面上真选了一个文件」，用 fetch 拼 multipart 会被判非法，
 * 所以必须走这条路。
 */
export async function fileUploadHtml(tab: BrowserTab, { startUrl, filePath, fileSelector = 'input[type=file]', timeoutMs = 30000, settleMs = 4000, prepareExpression = '', submitExpression = '', waitForExpression = '', extractExpression = '' }: FileUploadOptions): Promise<FileUploadResult> {
  if (!hostAllowed(startUrl)) throw new Error(`域名不在白名单：${hostOf(startUrl)}`)
  if (!filePath || !fs.existsSync(filePath)) throw new Error('上传用的临时图片不存在')
  await tab.send('Page.enable')
  await tab.send('DOM.enable')
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 25000))
    const onMessage = () => { clearTimeout(timer); resolve(true) }
    tab.cdp.on('Page.loadEventFired', onMessage)
    setTimeout(() => tab.cdp.off('Page.loadEventFired', onMessage), Math.min(timeoutMs, 25000) + 500)
  })
  const nav = await tab.send('Page.navigate', { url: startUrl })
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`)
  await loaded
  // 有些站点（谷歌 Lens 的 v3/upload）没有页面上的上传入口，得自己塞一个 form：
  // 用 prepareExpression 在页面里造出 <input type=file>，再走同一条「真选文件」的路。
  if (prepareExpression) {
    try { await tab.send('Runtime.evaluate', { expression: prepareExpression, returnByValue: true, awaitPromise: true }) } catch {}
    await sleep(300)
  }
  const nodeIdByObject = async () => {
    try {
      const evaluated = await tab.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(fileSelector)})` })
      const objectId = evaluated?.result?.objectId
      if (!objectId) return 0
      const node = await tab.send('DOM.requestNode', { objectId })
      return Number(node?.nodeId) || 0
    } catch { return 0 }
  }

  // 等 input 出现（JS 渲染的站点要等）
  const deadline = Date.now() + Math.min(timeoutMs, 20000)
  let nodeId = 0
  while (Date.now() < deadline) {
    if (prepareExpression) {
      nodeId = await nodeIdByObject()
      if (nodeId) break
    }
    const doc = await tab.send('DOM.getDocument', { depth: 2, pierce: false })
    const found = await tab.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: fileSelector })
    if (found?.nodeId) { nodeId = found.nodeId; break }
    await sleep(400)
  }
  if (!nodeId) throw new Error(`页面上找不到 ${fileSelector}（站点结构变了或需要交互）`)
  // 记下当前 URL：上传成功后通常会发生跳转，用「URL 变了」当第一条信号。
  const beforeUrl = String((await tab.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '')
  await tab.send('DOM.setFileInputFiles', { files: [filePath], nodeId })
  if (submitExpression) {
    try { await tab.send('Runtime.evaluate', { expression: submitExpression, returnByValue: true }) } catch {}
  }
  // 等结果：优先等 waitForExpression 变真；否则等一次 navigation/load 再 settle。
  if (waitForExpression) {
    const waitDeadline = Date.now() + Math.min(timeoutMs, 30000)
    while (Date.now() < waitDeadline) {
      try {
        const probe = await tab.send('Runtime.evaluate', { expression: waitForExpression, returnByValue: true })
        if (probe?.result?.value) break
      } catch { /* 跳转中的一瞬间页面上下文会消失，忽略继续等 */ }
      await sleep(500)
    }
    // 条件满足只代表「壳子在了」，结果卡片是异步渲染的，再给一段固定渲染时间
    await sleep(settleMs)
  } else {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(timeoutMs, 25000))
      const onMessage = () => {
        clearTimeout(timer)
        tab.cdp.off('Page.loadEventFired', onMessage)
        setTimeout(resolve, settleMs)
      }
      tab.cdp.on('Page.loadEventFired', onMessage)
    })
    // 页面没跳转（纯 JS 上传）也要给渲染时间
    const afterUrl = String((await tab.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '')
    if (afterUrl === beforeUrl) await sleep(settleMs)
  }
  const result = await tab.send('Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true
  })
  const html = String(result?.result?.value ?? '')
  const url = String((await tab.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '')
  if (extractExpression) {
    const extracted = await tab.send('Runtime.evaluate', { expression: extractExpression, returnByValue: true, awaitPromise: true })
    return { html, url, data: extracted?.result?.value }
  }
  return { html, url }
}

export interface VisitOptions {
  url: string
  waitForExpression?: string
  settleMs?: number
  extractExpression?: string
  timeoutMs?: number
}

/**
 * 不带文件地打开一个页面、等它渲染完、把结果交回来。
 * Lens 的「完全匹配」标签页就是在同一个结果页上换 udm 参数，所以需要这个轻量版本。
 */
export async function visit(tab: BrowserTab, { url, waitForExpression = '', settleMs = 2200, extractExpression = '', timeoutMs = 30000 }: VisitOptions): Promise<FileUploadResult> {
  if (!hostAllowed(url)) throw new Error(`域名不在白名单：${hostOf(url)}`)
  await tab.send('Page.enable')
  const nav = await tab.send('Page.navigate', { url })
  if (nav?.errorText) throw new Error(`打开页面失败：${nav.errorText}`)
  const condition = waitForExpression || 'document.readyState === "complete"'
  const deadline = Date.now() + Math.min(timeoutMs, 30000)
  while (Date.now() < deadline) {
    try {
      const probe = await tab.send('Runtime.evaluate', { expression: condition, returnByValue: true })
      if (probe?.result?.value) break
    } catch { /* 跳转中的一瞬间页面上下文会消失，忽略继续等 */ }
    await sleep(400)
  }
  await sleep(settleMs)
  const html = String((await tab.send('Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true
  }))?.result?.value ?? '')
  const finalUrl = String((await tab.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))?.result?.value ?? '')
  if (!extractExpression) return { html, url: finalUrl }
  const extracted = await tab.send('Runtime.evaluate', { expression: extractExpression, returnByValue: true, awaitPromise: true })
  return { html, url: finalUrl, data: extracted?.result?.value }
}

/**
 * 把 google 的 `/goto?url=<token>` 卡片解成真实域名。
 * 页面里 fetch 会被 CORS 挡死（跨域 302 → TypeError），所以让浏览器自己跳：
 * 开 Fetch 域拦请求，谷歌自己的请求放行，一旦出现非谷歌域名就记下来并中止加载 —— 不真的把目标页拉下来。
 */
export async function resolveLensGoto(tab: BrowserTab, wrapperUrl: string, { timeoutMs = 12000 } = {}): Promise<string> {
  const isGoogleHost = (url: string) => {
    try { return /(^|\.)google\.[a-z.]+$/i.test(new URL(url).hostname) } catch { return true }
  }
  try { await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }) } catch { return '' }
  const hit = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(''), timeoutMs)
    const onMessage = (params: any) => {
      const requestId = params?.requestId
      const url = String(params?.request?.url ?? '')
      if (!requestId) return
      if (isGoogleHost(url)) {
        tab.send('Fetch.continueRequest', { requestId }).catch(() => {})
        return
      }
      clearTimeout(timer)
      tab.cdp.off('Fetch.requestPaused', onMessage)
      tab.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {})
      resolve(url)
    }
    tab.cdp.on('Fetch.requestPaused', onMessage)
    setTimeout(() => tab.cdp.off('Fetch.requestPaused', onMessage), timeoutMs + 500)
  })
  try { await tab.send('Page.navigate', { url: wrapperUrl }) } catch {}
  const found = await hit
  try { await tab.send('Page.stopLoading') } catch {}
  try { await tab.send('Fetch.disable') } catch {}
  return found
}
