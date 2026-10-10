import { z } from 'zod'

export const DATA_OPERATIONS = [
  'boards.list', 'posts.search', 'posts.get', 'knowledge.search', 'knowledge.get',
  'drafts.create', 'drafts.update', 'drafts.get', 'drafts.list',
  'tasks.search', 'tasks.get', 'tasks.complete',
  'posts.publish.prepare', 'posts.publish.commit',
] as const
export type DataOperation = typeof DATA_OPERATIONS[number]
export const DATA_READ_SCOPES: DataOperation[] = [
  'boards.list', 'posts.search', 'posts.get', 'knowledge.search', 'knowledge.get',
  'drafts.get', 'drafts.list', 'tasks.search', 'tasks.get',
]
export const DATA_WRITE_SCOPES: DataOperation[] = ['drafts.create', 'drafts.update', 'tasks.complete']
export const DATA_PUBLISH_SCOPES: DataOperation[] = ['posts.publish.prepare', 'posts.publish.commit']

const id = z.string().uuid()
const query = z.string().max(256).refine(value => !value.includes('\0'))
const limit = z.number().int().min(1).max(20)
const offset = z.number().int().min(0).max(10000)
const content = z.string().min(1).max(4000).refine(value => Boolean(value.trim()) && !value.includes('\0'))
const item = z.object({ id }).strict()
const search = z.object({ group_id: id.optional(), query: query.optional(), limit: limit.optional(), offset: offset.optional() }).strict()
const schemas: Record<DataOperation, z.ZodTypeAny> = {
  'boards.list': z.object({ query: query.optional(), limit: limit.optional(), offset: offset.optional() }).strict(),
  'posts.search': search, 'posts.get': item,
  'knowledge.search': search, 'knowledge.get': item,
  'drafts.create': z.object({ group_id: id, content }).strict(),
  'drafts.update': z.object({ id, content }).strict(),
  'drafts.get': item,
  'drafts.list': z.object({ group_id: id.optional(), limit: limit.optional(), offset: offset.optional() }).strict(),
  'tasks.search': search, 'tasks.get': item, 'tasks.complete': item,
  'posts.publish.prepare': item, 'posts.publish.commit': item,
}
const versioned: DataOperation[] = ['drafts.update', 'tasks.complete', ...DATA_PUBLISH_SCOPES]
export const dataExecuteSchema = z.object({
  operation: z.enum(DATA_OPERATIONS),
  input: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/).optional(),
  expectedVersion: z.string().min(1).max(80).regex(/^[\x21-\x7e]+$/).optional(),
  confirmationId: id.optional(),
}).strict().superRefine((body, ctx) => {
  const result = schemas[body.operation].safeParse(body.input)
  if (!result.success) ctx.addIssue({ code: 'custom', path: ['input'], message: '入力項目または値が不正です' })
  const mutation = !DATA_READ_SCOPES.includes(body.operation)
  if (mutation !== Boolean(body.idempotencyKey)) ctx.addIssue({ code: 'custom', path: ['idempotencyKey'], message: mutation ? '更新には冪等キーが必要です' : '読取では指定できません' })
  if (versioned.includes(body.operation) !== Boolean(body.expectedVersion)) ctx.addIssue({ code: 'custom', path: ['expectedVersion'], message: 'この操作に対応するversionを指定してください' })
  if ((body.operation === 'posts.publish.commit') !== Boolean(body.confirmationId)) ctx.addIssue({ code: 'custom', path: ['confirmationId'], message: '公開の確定には確認IDが必要です' })
})

const connectionPermissions = {
  scopes: z.array(z.enum(DATA_OPERATIONS)).min(1).max(DATA_OPERATIONS.length),
  allowedGroupIds: z.array(id).max(20),
  allBoards: z.boolean().default(false),
  pcName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).nullable().optional(),
}
export const dataAdminSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'), label: z.string().trim().min(1).max(80),
    ...connectionPermissions,
    expiresAt: z.string().datetime({ offset: true }),
    maxLimit: z.number().int().min(1).max(20).default(20),
  }).strict(),
  z.object({ action: z.literal('permissions'), id, ...connectionPermissions }).strict(),
  z.object({ action: z.literal('revoke'), id }).strict(),
  z.object({ action: z.literal('approve_confirmation'), id, digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]).superRefine((body, ctx) => {
  if (body.action === 'create' || body.action === 'permissions') {
    if (body.allBoards ? body.allowedGroupIds.length !== 0 : body.allowedGroupIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowedGroupIds'], message: '全掲示板なら対象IDは空、限定接続なら掲示板を選択してください' })
    }
  }
})
