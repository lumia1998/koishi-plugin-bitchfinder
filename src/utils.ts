// ── 小工具 ────────────────────────────────────────────────────────────────
// 计时器不 unref：unref 后独自跑脚本时会「事件循环空了」直接退出（exit 13）。
export const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

export function hostOf(url: string): string {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

export function decodeEntities(s: string): string {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

export function stripTags(s: string): string {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function absUrl(href: string, base: string): string {
  try { return new URL(decodeEntities(href), base).toString() } catch { return '' }
}

export function trimText(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
