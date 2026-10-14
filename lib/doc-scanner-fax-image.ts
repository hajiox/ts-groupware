import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'

export const NORMALIZED_FAX_IMAGE_TYPE = 'image/jpeg'
const FAX_IMAGE_MAX_WIDTH = 1600
const FAX_IMAGE_QUALITY = 82

const orientationSchema = z.object({
  version: z.literal(2),
  owner: z.literal('docscanner'),
  page: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(value => value.toLowerCase()),
  rotationDegrees: z.union([z.literal(0), z.literal(180)]),
  status: z.enum(['upright', 'corrected', 'uncertain']),
  method: z.literal('body-text-pair'),
  confidence: z.number().min(0).max(1),
}).strict().refine(value => value.rotationDegrees === (value.status === 'corrected' ? 180 : 0))

export type FaxOrientationReceipt = z.infer<typeof orientationSchema>

export class FaxImageInputError extends Error {}

export function parseFaxOrientationReceipt(value: unknown, sourcePage?: number, sourcePageCount?: number) {
  if (value === undefined) return undefined
  const parsed = orientationSchema.safeParse(value)
  if (!parsed.success || !Number.isSafeInteger(sourcePage) || parsed.data.page !== sourcePage
    || (sourcePageCount !== undefined && (!Number.isSafeInteger(sourcePageCount)
      || sourcePageCount < parsed.data.page))) {
    throw new FaxImageInputError('FAX orientation receipt is invalid')
  }
  return parsed.data
}

export async function normalizeFaxImageBuffer(buffer: Buffer, orientation?: FaxOrientationReceipt) {
  const receivedSha256 = createHash('sha256').update(buffer).digest('hex')
  if (orientation && orientation.sha256 !== receivedSha256) {
    throw new FaxImageInputError('FAX orientation image hash mismatch')
  }
  let normalizedBuffer: Buffer
  try {
    // Document content is never evidence for a second rotation. DocScanner owns
    // semantic orientation; the receiver only applies explicit EXIF orientation.
    normalizedBuffer = await sharp(buffer)
      .rotate()
      .flatten({ background: '#fff' })
      .resize({ width: FAX_IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: FAX_IMAGE_QUALITY, mozjpeg: true })
      .toBuffer()
  } catch {
    throw new FaxImageInputError('FAX image could not be normalized')
  }
  return {
    buffer: normalizedBuffer,
    type: NORMALIZED_FAX_IMAGE_TYPE,
    receivedSha256,
    storedSha256: createHash('sha256').update(normalizedBuffer).digest('hex'),
    rotationCorrected: orientation?.status === 'corrected',
    rotationReason: orientation
      ? 'DocScanner orientation receipt retained; TSG applies EXIF only'
      : 'EXIF orientation only; document-content rotation is disabled',
  }
}
