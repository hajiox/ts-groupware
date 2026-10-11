import { NextRequest } from 'next/server'
import { getBusinessOperation, type BusinessMethod, type BusinessOperation } from './catalog'

export type BusinessOperationInput = {
  query?: Record<string, string | number | boolean>
  params?: Record<string, string>
  body?: Record<string, unknown>
  form?: Record<string, string>
  files?: Array<{ field: string; name: string; type: string; base64: string }>
}
export type BusinessDispatchResult = { status: number; body: unknown } | {
  status: number; file: { name: string; type: string; base64: string }
}

const MAX_BINARY_BYTES = 2 * 1024 * 1024
const MAX_JSON_BYTES = 3 * 1024 * 1024
const MAX_QUERY_BYTES = 32768
const CANONICAL_ORIGIN = 'https://v0-line-blush.vercel.app'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>

// Literal module paths let Next bundle only verified application handlers. There
// is no fetch to a caller-provided URL and no browser session is constructed.
const loaders = {
  '/api/admin/users': () => import('@/app/api/admin/users/route'),
  '/api/groups': () => import('@/app/api/groups/route'),
  '/api/admin/groups': () => import('@/app/api/admin/groups/route'),
  '/api/groups/[id]/members': () => import('@/app/api/groups/[id]/members/route'),
  '/api/admin/members': () => import('@/app/api/admin/members/route'),
  '/api/admin/hr/employees': () => import('@/app/api/admin/hr/employees/route'),
  '/api/admin/hr/resumes': () => import('@/app/api/admin/hr/resumes/route'),
  '/api/admin/attendance': () => import('@/app/api/admin/attendance/route'),
  '/api/admin/attendance/export': () => import('@/app/api/admin/attendance/export/route'),
  '/api/admin/attendance/submit': () => import('@/app/api/admin/attendance/submit/route'),
  '/api/attendance/present': () => import('@/app/api/attendance/present/route'),
  '/api/attendance/punches': () => import('@/app/api/attendance/punches/route'),
  '/api/admin/payroll/employees': () => import('@/app/api/admin/payroll/employees/route'),
  '/api/admin/payroll/employee-aliases': () => import('@/app/api/admin/payroll/employee-aliases/route'),
  '/api/admin/payroll/diff': () => import('@/app/api/admin/payroll/diff/route'),
  '/api/admin/payroll/calculation-profiles': () => import('@/app/api/admin/payroll/calculation-profiles/route'),
  '/api/admin/payroll/labor-costs': () => import('@/app/api/admin/payroll/labor-costs/route'),
  '/api/admin/payroll/stability': () => import('@/app/api/admin/payroll/stability/route'),
  '/api/admin/payroll/mail-jobs': () => import('@/app/api/admin/payroll/mail-jobs/route'),
  '/api/admin/labor/imports': () => import('@/app/api/admin/labor/imports/route'),
  '/api/admin/labor/imports/upload': () => import('@/app/api/admin/labor/imports/upload/route'),
  '/api/admin/labor/imports/[batchId]/analyze': () => import('@/app/api/admin/labor/imports/[batchId]/analyze/route'),
  '/api/admin/labor/imports/reconcile': () => import('@/app/api/admin/labor/imports/reconcile/route'),
  '/api/admin/paid-leave': () => import('@/app/api/admin/paid-leave/route'),
  '/api/admin/paid-leave/pending': () => import('@/app/api/admin/paid-leave/pending/route'),
  '/api/paid-leave': () => import('@/app/api/paid-leave/route'),
  '/api/bereavement-leave': () => import('@/app/api/bereavement-leave/route'),
  '/api/admin/appraisals': () => import('@/app/api/admin/appraisals/route'),
  '/api/admin/pledges': () => import('@/app/api/admin/pledges/route'),
  '/api/admin/pledges/paper': () => import('@/app/api/admin/pledges/paper/route'),
  '/api/pledges': () => import('@/app/api/pledges/route'),
  '/api/pledges/pdf': () => import('@/app/api/pledges/pdf/route'),
  '/api/admin/shifts': () => import('@/app/api/admin/shifts/route'),
  '/api/admin/shifts/export': () => import('@/app/api/admin/shifts/export/route'),
  '/api/shifts/confirmed': () => import('@/app/api/shifts/confirmed/route'),
  '/api/shifts/requests': () => import('@/app/api/shifts/requests/route'),
  '/api/shifts/alerts': () => import('@/app/api/shifts/alerts/route'),
  '/api/calendar/events': () => import('@/app/api/calendar/events/route'),
  '/api/calendar/import/google': () => import('@/app/api/calendar/import/google/route'),
  '/api/posts': () => import('@/app/api/posts/route'),
  '/api/chat': () => import('@/app/api/chat/route'),
  '/api/chat/direct': () => import('@/app/api/chat/direct/route'),
  '/api/dm/unread': () => import('@/app/api/dm/unread/route'),
  '/api/tasks': () => import('@/app/api/tasks/route'),
  '/api/reactions': () => import('@/app/api/reactions/route'),
  '/api/home-company-messages': () => import('@/app/api/home-company-messages/route'),
  '/api/home/ec-sales': () => import('@/app/api/home/ec-sales/route'),
  '/api/notifications/center': () => import('@/app/api/notifications/center/route'),
  '/api/notifications/posts': () => import('@/app/api/notifications/posts/route'),
  '/api/notifications/settings': () => import('@/app/api/notifications/settings/route'),
  '/api/unread': () => import('@/app/api/unread/route'),
  '/api/unread/clear': () => import('@/app/api/unread/clear/route'),
  '/api/sos': () => import('@/app/api/sos/route'),
  '/api/upload': () => import('@/app/api/upload/route'),
} satisfies Record<string, () => Promise<unknown>>

function failure(message: string, status = 400): BusinessDispatchResult {
  return { status, body: { error: message } }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateInput(operation: BusinessOperation, input: BusinessOperationInput): string | null {
  if (!plainRecord(input) || Object.keys(input).some(key => !['query', 'params', 'body', 'form', 'files'].includes(key))) return '入力形式が不正です'
  if (input.params !== undefined && !plainRecord(input.params)) return '経路パラメーターが不正です'
  const params = input.params || {}
  if (Object.keys(params).length !== operation.params.length || operation.params.some(key => typeof params[key] !== 'string' || !uuid.test(params[key]))) return '経路IDは必要なUUIDだけを指定してください'
  if (input.query !== undefined && !plainRecord(input.query)) return '検索条件が不正です'
  if (Object.entries(input.query || {}).some(([key, value]) => !operation.queryFields.includes(key)
    || !['string', 'number', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && !Number.isFinite(value))
    || String(value).includes('\0') || String(value).length > 8192)) return '未対応の検索条件または値です'
  if (Buffer.byteLength(JSON.stringify(input.query || {}), 'utf8') > MAX_QUERY_BYTES) return '検索条件が大きすぎます'
  if (operation.bodyMode === 'none' && (input.body !== undefined || input.form !== undefined || input.files !== undefined)) return 'この操作には本文や添付を指定できません'
  if (operation.bodyMode === 'json') {
    if (input.form !== undefined || input.files !== undefined) return 'この操作はJSON本文だけを受け付けます'
    if (input.body !== undefined && !plainRecord(input.body)) return 'JSON本文はオブジェクトで指定してください'
    if (Buffer.byteLength(JSON.stringify(input.body || {}), 'utf8') > MAX_JSON_BYTES) return 'JSON本文が大きすぎます'
    const action = input.body?.action
    if (action !== undefined && operation.actions.length && (typeof action !== 'string' || !operation.actions.includes(action))) return 'この操作に対応しないactionです'
  }
  if (operation.bodyMode === 'multipart') {
    if (input.body !== undefined || (input.form !== undefined && !plainRecord(input.form))) return 'ファイル操作はformとfilesで指定してください'
    if (Object.entries(input.form || {}).some(([key, value]) => !operation.formFields.includes(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768)) return 'フォーム項目が不正です'
    if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 12)) return '添付ファイルは最大12件です'
  }
  return null
}

function createMultipart(operation: BusinessOperation, input: BusinessOperationInput): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(input.form || {})) form.append(key, value)
  let total = 0
  for (const file of input.files || []) {
    if (!plainRecord(file) || Object.keys(file).some(key => !['field', 'name', 'type', 'base64'].includes(key))
      || typeof file.field !== 'string' || !operation.fileFields.includes(file.field)
      || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)
      || typeof file.type !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(file.type)
      || typeof file.base64 !== 'string' || !file.base64 || file.base64.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('添付ファイルの項目・名前・形式を確認してください')
    const bytes = Buffer.from(file.base64, 'base64')
    if (!bytes.length || bytes.toString('base64') !== file.base64) throw new Error('添付ファイルのbase64が不正です')
    total += bytes.length
    if (total > MAX_BINARY_BYTES) throw new Error('MCP添付の合計サイズは2MiB以内です')
    form.append(file.field, new File([new Uint8Array(bytes)], file.name, { type: file.type }))
  }
  return form
}

function responseFileName(response: Response) {
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let name = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1] || 'download'
  if (encoded) {
    try { name = decodeURIComponent(encoded) } catch { /* Fall back to the safe default/plain filename. */ }
  }
  return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255) || 'download'
}

export async function dispatchBusinessOperation(id: string, input: BusinessOperationInput): Promise<BusinessDispatchResult> {
  const operation = getBusinessOperation(id)
  if (!operation || !Object.hasOwn(loaders, operation.path)) return failure('未対応の業務操作です', 404)
  const invalid = validateInput(operation, input)
  if (invalid) return failure(invalid)
  const params = input.params || {}
  const path = operation.path.replace(/\[([A-Za-z]+)\]/g, (_, key: string) => encodeURIComponent(params[key]))
  const url = new URL(path, CANONICAL_ORIGIN)
  for (const [key, value] of Object.entries(input.query || {})) url.searchParams.set(key, String(value))
  const headers = new Headers({ origin: CANONICAL_ORIGIN })
  let body: BodyInit | undefined
  if (operation.bodyMode === 'multipart') {
    try { body = createMultipart(operation, input) }
    catch (error) { return failure(error instanceof Error ? error.message : '添付ファイルが不正です') }
  } else if (operation.bodyMode === 'json') {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(input.body || {})
  }
  const request = new NextRequest(url, { method: operation.method, headers, ...(body !== undefined ? { body } : {}) })
  const load = loaders[operation.path as keyof typeof loaders]
  const route = await load() as Partial<Record<BusinessMethod, RouteHandler>>
  const handler = route[operation.method]
  if (!handler) return failure('業務操作の実装が見つかりません', 500)
  const response = await handler(request, { params: Promise.resolve(params) })
  const type = response.headers.get('content-type') || 'application/octet-stream'
  if (/^application\/(?:[a-zA-Z0-9.+-]+\+)?json(?:;|$)/i.test(type)) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) return failure('応答が大きすぎます。検索条件を絞ってください', 413)
    try { return { status: response.status, body: JSON.parse(text) } }
    catch { return failure('業務APIの応答形式が不正です', 502) }
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_BINARY_BYTES) return failure('MCP出力ファイルは2MiB以内です。対象を絞ってください', 413)
  return { status: response.status, file: { name: responseFileName(response), type: type.split(';')[0], base64: bytes.toString('base64') } }
}
