import { createHash } from 'node:crypto'

export function recipePriceChangePostId(sourceKey: string) {
  const bytes = createHash('sha256')
    .update(`tsa_recipe_price_change:${sourceKey}`, 'utf8')
    .digest()
    .subarray(0, 16)
  // Mark the deterministic 128-bit value as an RFC 4122 variant/version-5 UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function requiredRecipePriceText(value: unknown, field: string, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maxLength) throw new Error(`${field} is invalid`)
  return text
}

function optionalText(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maxLength) : null
}

function positiveNumber(value: unknown, field: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} is invalid`)
  return number
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function formatPrice(value: number) {
  return `¥${Math.floor(value).toLocaleString('ja-JP')}`
}

type NormalizedPriceChange = {
  recipeId: string
  productName: string
  previousPriceExTax: number
  newPriceExTax: number
  previousPriceInclTax: number
  newPriceInclTax: number
  changedAt: string | null
}

function normalizeRecipePriceChange(body: Record<string, unknown>): NormalizedPriceChange {
  const recipeId = requiredRecipePriceText(body.recipeId, 'recipeId', 100)
  const recipeName = singleLine(requiredRecipePriceText(body.recipeName, 'recipeName', 200))
  const ecProductName = optionalText(body.ecProductName, 200)
  const productName = ecProductName ? singleLine(ecProductName) : recipeName
  const previousPriceExTax = positiveNumber(body.previousPriceExTax, 'previousPriceExTax')
  const newPriceExTax = positiveNumber(body.newPriceExTax, 'newPriceExTax')
  const previousPriceInclTax = positiveNumber(body.previousPriceInclTax, 'previousPriceInclTax')
  const newPriceInclTax = positiveNumber(body.newPriceInclTax, 'newPriceInclTax')
  if (previousPriceInclTax === newPriceInclTax && previousPriceExTax === newPriceExTax) {
    throw new Error('price was not changed')
  }

  const changedAtValue = optionalText(body.changedAt, 50)
  const changedAt = changedAtValue && Number.isFinite(Date.parse(changedAtValue))
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(changedAtValue))
    : null
  return {
    recipeId,
    productName,
    previousPriceExTax,
    newPriceExTax,
    previousPriceInclTax,
    newPriceInclTax,
    changedAt,
  }
}

export function buildRecipePriceChangeContent(body: Record<string, unknown>, sourceKey: string) {
  const change = normalizeRecipePriceChange(body)
  const {
    recipeId,
    productName,
    previousPriceExTax,
    newPriceExTax,
    previousPriceInclTax,
    newPriceInclTax,
    changedAt,
  } = change
  const difference = Math.floor(newPriceInclTax - previousPriceInclTax)
  const differenceLabel = `${difference >= 0 ? '+' : ''}${difference.toLocaleString('ja-JP')}円`

  return [
    '【販売価格変更】',
    '@フロア',
    `商品: ${productName}`,
    `前回価格（税込）: ${formatPrice(previousPriceInclTax)}`,
    `新価格（税込）: ${formatPrice(newPriceInclTax)}（${differenceLabel}）`,
    `税抜価格: ${formatPrice(previousPriceExTax)} → ${formatPrice(newPriceExTax)}`,
    changedAt ? `登録日時: ${changedAt}` : '',
    `TSAレシピ: https://v0-tsa-19.vercel.app/recipe/${encodeURIComponent(recipeId)}`,
    `連携ID: tsa-recipe-price:${sourceKey}`,
  ].filter(Boolean).join('\n')
}

export function buildRecipePriceBatchChangeContent(body: Record<string, unknown>, sourceKey: string) {
  const rawItems = Array.isArray(body.items) ? body.items : []
  if (rawItems.length === 0 || rawItems.length > 200) throw new Error('items is invalid')
  const changes = rawItems.map((item) => normalizeRecipePriceChange(
    item && typeof item === 'object' ? item as Record<string, unknown> : {},
  ))
  if (new Set(changes.map(change => change.recipeId)).size !== changes.length) {
    throw new Error('recipeId is duplicated')
  }

  const detailLines = changes.flatMap((change, index) => {
    const difference = Math.floor(change.newPriceInclTax - change.previousPriceInclTax)
    const differenceLabel = `${difference >= 0 ? '+' : ''}${difference.toLocaleString('ja-JP')}円`
    return [
      `${index + 1}. ${change.productName}`,
      `税込: ${formatPrice(change.previousPriceInclTax)} → ${formatPrice(change.newPriceInclTax)}（${differenceLabel}） / 税抜: ${formatPrice(change.previousPriceExTax)} → ${formatPrice(change.newPriceExTax)}`,
      `TSAレシピ: https://v0-tsa-19.vercel.app/recipe/${encodeURIComponent(change.recipeId)}`,
    ]
  })
  const changedDates = changes.map(change => change.changedAt).filter(Boolean)
  const changedAt = changedDates[changedDates.length - 1]

  return [
    '【販売価格一括変更】',
    '@フロア',
    `${changes.length}商品のEC価格改定が完了しました。`,
    ...detailLines,
    changedAt ? `最終登録日時: ${changedAt}` : '',
    `連携ID: tsa-recipe-price:${sourceKey}`,
  ].filter(Boolean).join('\n')
}
