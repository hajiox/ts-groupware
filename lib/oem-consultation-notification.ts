import { createHash } from 'node:crypto'
import { z } from 'zod'

export const OEM_CONSULTATION_BOARD_ID = 'd6453519-ab54-4946-9762-ed266f59cb1e'
export const OEM_CONSULTATION_DASHBOARD_URL = 'https://oem.aizubrandhall.com/admin/dashboard'

// Match the OEM intake snapshot contract, including astral Unicode characters.
// Labels are business data; only the server-owned dashboard field controls links.
const label = z.string().min(1).refine(value => value.trim().length > 0
  && Array.from(value).length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value))

const receivedAt = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(value => Number.isFinite(Date.parse(value)))

const inputSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.literal('consultation_received'),
  sourceKey: z.string().min(1).max(200),
  leadId: z.string().uuid().transform(value => value.toLowerCase()),
  receivedAt,
  companyName: label,
  productName: label,
  quantityLabel: label,
  estimatedTotalPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

export function oemConsultationNotification(raw: unknown) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw new Error('consultation notification is invalid')
  const input = parsed.data
  if (input.sourceKey !== `oem:consultation:${input.leadId}:received:v1`) {
    throw new Error('sourceKey is invalid')
  }

  const receivedAt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(input.receivedAt))
  const content = [
    '【OEM見積もり相談・受付】',
    '新しい相談を受け付けました。受注確定ではありません。',
    `受付日時：${receivedAt}（日本時間）`,
    `会社：${input.companyName}`,
    `商品：${input.productName}`,
    `数量：${input.quantityLabel}`,
    `概算合計：${input.estimatedTotalPrice.toLocaleString('ja-JP')}円（税別・試作費別）`,
    '',
    'OEM相談管理画面',
    OEM_CONSULTATION_DASHBOARD_URL,
  ].join('\n')
  return { sourceKey: input.sourceKey, content }
}

export function oemConsultationNotificationPostId(sourceKey: string) {
  // Separate namespace prevents collisions with the general board-post API.
  const bytes = createHash('sha256').update(`tsg_oem_consultation_received:${sourceKey}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
