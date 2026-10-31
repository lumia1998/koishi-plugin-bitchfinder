/**
 * 图片预处理与感知哈希。
 *
 * 参考原版做法：符合条件的 JPEG/PNG/WebP（无 EXIF 方向、最长边 <=1600px）
 * 保留原始字节——重新编码会改变图像内容，伤害反向搜索命中率；其他图片
 * 纠正方向、缩放、透明区填白转 JPEG、动图只取第一帧。
 */

import sharp from 'sharp'

const MAX_SIDE = 1600
const JPEG_QUALITY = 92

/** 返回适合送入反搜引擎的 Buffer；不可解码时原样返回。 */
export async function prepareImage(data: Buffer): Promise<Buffer> {
  let meta: sharp.Metadata
  try {
    meta = await sharp(data, { failOn: 'none' }).metadata()
  } catch {
    return data
  }

  const fmt = (meta.format || '').toLowerCase()
  const orientation = meta.orientation || 1
  const width = meta.width || 0
  const height = meta.height || 0

  if (
    ['jpeg', 'png', 'webp'].includes(fmt) &&
    Math.max(width, height) <= MAX_SIDE &&
    orientation <= 1
  ) {
    return data
  }

  try {
    return await sharp(data, { animated: false, failOn: 'none' })
      .rotate() // 无参数时按 EXIF Orientation 自动纠正
      .flatten({ background: '#ffffff' })
      .resize(MAX_SIDE, MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer()
  } catch {
    return data
  }
}

/** 按文件头判断图片格式（不依赖扩展名/媒体类型声明）。 */
export function imageFormat(
  data: Buffer,
): 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown' {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpeg'
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'png'
  }
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  if (data.length >= 6 && data.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'unknown'
}

/**
 * 把图片压到 maxBytes 以内，供对上传体积有硬限制的接口使用
 * （例如 SerpApi Image API 限 500 KB、仅接受 JPG/PNG/WebP）。
 * 已在限制内则原样返回，避免不必要的重编码。
 */
export async function compressToMaxBytes(
  data: Buffer,
  maxBytes: number,
  force = false,
): Promise<Buffer> {
  if (!force && data.length <= maxBytes) return data
  for (const side of [1600, 1200, 960, 720, 480]) {
    for (const quality of [90, 80, 70, 60]) {
      try {
        const out = await sharp(data, { animated: false, failOn: 'none' })
          .rotate()
          .flatten({ background: '#ffffff' })
          .resize(side, side, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer()
        if (out.length <= maxBytes) return out
      } catch {
        return data
      }
    }
  }
  return data
}

export interface PerceptualHashes {
  a: bigint
  d: bigint
}

function popcount(value: bigint): number {
  return value.toString(2).split('1').length - 1
}

/** 返回 (aHash64, dHash64)，失败返回 null。 */
export async function perceptualHashes(data: Buffer): Promise<PerceptualHashes | null> {
  try {
    const base = sharp(data, { animated: false, failOn: 'none' })
      .rotate()
      .greyscale()
    const aRaw = await base
      .clone()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer()
    const dRaw = await base
      .clone()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer()
    if (aRaw.length < 64 || dRaw.length < 72) return null

    let sum = 0
    for (let i = 0; i < 64; i++) sum += aRaw[i]
    const avg = sum / 64

    let ahash = 0n
    for (let i = 0; i < 64; i++) {
      if (aRaw[i] > avg) ahash |= 1n << BigInt(i)
    }

    let dhash = 0n
    let bit = 0
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (dRaw[row * 9 + col] > dRaw[row * 9 + col + 1]) {
          dhash |= 1n << BigInt(bit)
        }
        bit++
      }
    }
    return { a: ahash, d: dhash }
  } catch {
    return null
  }
}

/** 两组哈希的归一化汉明相似度（0-1）。 */
export function hashSimilarity(h1: PerceptualHashes, h2: PerceptualHashes): number {
  const sim = (a: bigint, b: bigint) => 1 - popcount(a ^ b) / 64
  return (sim(h1.a, h2.a) + sim(h1.d, h2.d)) / 2
}
