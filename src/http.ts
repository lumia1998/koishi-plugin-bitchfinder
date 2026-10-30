/**
 * 轻量 HTTP 客户端。
 *
 * 使用 Node 内置 fetch（Node 18+），并通过 undici 的 ProxyAgent 支持
 * 显式代理；不读取系统代理环境变量（与原版 trust_env=False 一致）。
 * 所有请求都关闭证书校验，兼容国内环境下部分引擎的证书链问题。
 */

import { EngineError } from './types'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface RequestOptions {
  timeout?: number
  headers?: Record<string, string>
  method?: string
  body?: any
  query?: Record<string, string | number | undefined>
  /** 覆盖客户端的代理设置 */
  proxy?: string
}

function buildUrl(url: string, query?: RequestOptions['query']): string {
  if (!query) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) u.searchParams.set(key, String(value))
  }
  return u.toString()
}

export class HttpClient {
  private dispatchers = new Map<string, Promise<any>>()

  constructor(
    public proxy = '',
    public defaultTimeout = 20,
  ) {}

  /**
   * 延迟加载 undici dispatcher。未安装 undici 时返回 undefined，
   * 退化为直连 fetch（代理配置不生效）。
   */
  private getDispatcher(proxy: string): Promise<any> {
    const key = proxy || ''
    let pending = this.dispatchers.get(key)
    if (!pending) {
      pending = (async () => {
        try {
          const undici: any = await import('undici')
          if (key) {
            return new undici.ProxyAgent({
              uri: key,
              requestTls: { rejectUnauthorized: false },
              proxyTls: { rejectUnauthorized: false },
            })
          }
          return new undici.Agent({ connect: { rejectUnauthorized: false } })
        } catch {
          return undefined
        }
      })()
      this.dispatchers.set(key, pending)
    }
    return pending
  }

  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const timeout = options.timeout ?? this.defaultTimeout
    const proxy = options.proxy ?? this.proxy
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout) * 1000)
    try {
      const dispatcher = await this.getDispatcher(proxy)
      const headers: Record<string, string> = {
        'User-Agent': UA,
        ...(options.headers || {}),
      }
      const init: any = {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
        redirect: 'follow',
      }
      if (dispatcher) init.dispatcher = dispatcher
      return await fetch(buildUrl(url, options.query), init)
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new EngineError(`请求超时（${timeout}s）`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    const resp = await this.request(url, options)
    if (!resp.ok) throw new EngineError(`HTTP ${resp.status}`)
    return resp.text()
  }

  async getJson<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
    const resp = await this.request(url, options)
    if (!resp.ok) throw new EngineError(`HTTP ${resp.status}`)
    const text = await resp.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new EngineError(`响应不是合法 JSON: ${text.slice(0, 120)}`)
    }
  }

  async getBuffer(url: string, options: RequestOptions = {}): Promise<Buffer> {
    const resp = await this.request(url, options)
    if (!resp.ok) throw new EngineError(`HTTP ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  }

  /** 以 multipart/form-data 上传单个文件字段。 */
  async postFile(
    url: string,
    field: string,
    data: Buffer,
    options: RequestOptions & {
      filename?: string
      contentType?: string
      extraFields?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const form = new FormData()
    form.append(
      field,
      new Blob([new Uint8Array(data)], { type: options.contentType || 'image/jpeg' }),
      options.filename || 'blob',
    )
    for (const [k, v] of Object.entries(options.extraFields || {})) {
      form.append(k, v)
    }
    return this.request(url, {
      ...options,
      method: 'POST',
      body: form,
    })
  }

  async postFileJson<T = any>(
    url: string,
    field: string,
    data: Buffer,
    options: RequestOptions & {
      filename?: string
      contentType?: string
      extraFields?: Record<string, string>
    } = {},
  ): Promise<T> {
    const resp = await this.postFile(url, field, data, options)
    if (!resp.ok) throw new EngineError(`HTTP ${resp.status}`)
    const text = await resp.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new EngineError(`响应不是合法 JSON: ${text.slice(0, 120)}`)
    }
  }
}
