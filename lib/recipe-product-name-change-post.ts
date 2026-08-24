import { createHash } from 'node:crypto'

export function recipeProductNameChangePostId(sourceKey: string) {
  const bytes = createHash('sha256')
    .update(`tsa_recipe_product_name_change:${sourceKey}`, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function requiredProductNameText(value: unknown, field: string, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maxLength) throw new Error(`${field} is invalid`)
  return text
}

function optionalText(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maxLength) : null
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

type NormalizedNameChange = {
  recipeId: string
  recipeName: string
  previousProductName: string | null
  newProductName: string
  changedAt: string | null
}

function normalizeChange(body: Record<string, unknown>): NormalizedNameChange {
  const recipeId = requiredProductNameText(body.recipeId, 'recipeId', 100)
  const recipeName = singleLine(requiredProductNameText(body.recipeName, 'recipeName', 200))
  const previousProductName = optionalText(body.previousProductName, 75)
  const newProductName = singleLine(requiredProductNameText(body.newProductName, 'newProductName', 75))
  if (previousProductName && singleLine(previousProductName) === newProductName) throw new Error('product name was not changed')
  const changedAtValue = optionalText(body.changedAt, 50)
  const changedAt = changedAtValue && Number.isFinite(Date.parse(changedAtValue))
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(changedAtValue))
    : null
  return { recipeId, recipeName, previousProductName, newProductName, changedAt }
}

export function buildRecipeProductNameChangeContent(body: Record<string, unknown>, sourceKey: string) {
  const change = normalizeChange(body)
  return [
    '【EC用商品名変更】',
    '@フロア',
    `商品: ${change.recipeName}`,
    `変更前: ${change.previousProductName ? singleLine(change.previousProductName) : '未登録'}`,
    `変更後: ${change.newProductName}`,
    change.changedAt ? `登録日時: ${change.changedAt}` : '',
    `TSAレシピ: https://v0-tsa-19.vercel.app/recipe/${encodeURIComponent(change.recipeId)}`,
    `連携ID: tsa-recipe-product-name:${sourceKey}`,
  ].filter(Boolean).join('\n')
}

export function buildRecipeProductNameBatchChangeContent(body: Record<string, unknown>, sourceKey: string) {
  const rawItems = Array.isArray(body.items) ? body.items : []
  if (rawItems.length === 0 || rawItems.length > 200) throw new Error('items is invalid')
  const changes = rawItems.map(item => normalizeChange(
    item && typeof item === 'object' ? item as Record<string, unknown> : {},
  ))
  if (new Set(changes.map(change => change.recipeId)).size !== changes.length) throw new Error('recipeId is duplicated')
  return [
    '【EC用商品名一括変更】',
    '@フロア',
    `${changes.length}商品のEC用商品名変更が完了しました。`,
    ...changes.flatMap((change, index) => [
      `${index + 1}. ${change.recipeName}`,
      `${change.previousProductName ? singleLine(change.previousProductName) : '未登録'} → ${change.newProductName}`,
      `TSAレシピ: https://v0-tsa-19.vercel.app/recipe/${encodeURIComponent(change.recipeId)}`,
    ]),
    `連携ID: tsa-recipe-product-name:${sourceKey}`,
  ].join('\n')
}
