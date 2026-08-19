const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'recipe-price-change-post.ts'),
  'utf8',
)
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require)

const deterministicId = loaded.exports.recipePriceChangePostId('revision-id')
assert.match(deterministicId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.equal(loaded.exports.recipePriceChangePostId('revision-id'), deterministicId)
assert.notEqual(loaded.exports.recipePriceChangePostId('other-revision'), deterministicId)

const content = loaded.exports.buildRecipePriceChangeContent({
  recipeId: 'recipe-id',
  recipeName: 'テスト\n商品',
  ecProductName: 'EC テスト商品',
  previousPriceExTax: 4158,
  newPriceExTax: 4250,
  previousPriceInclTax: 4490,
  newPriceInclTax: 4590,
  changedAt: '2026-08-19T00:00:00.000Z',
}, 'revision-id')

assert.match(content, /【販売価格変更】/)
assert.match(content, /@フロア/)
assert.match(content, /商品: EC テスト商品/)
assert.match(content, /前回価格（税込）: ¥4,490/)
assert.match(content, /新価格（税込）: ¥4,590（\+100円）/)
assert.match(content, /連携ID: tsa-recipe-price:revision-id/)
assert.doesNotMatch(content, /テスト\n商品/)
assert.throws(() => loaded.exports.buildRecipePriceChangeContent({
  recipeId: 'recipe-id',
  recipeName: '同額',
  previousPriceExTax: 100,
  newPriceExTax: 100,
  previousPriceInclTax: 108,
  newPriceInclTax: 108,
}, 'same-price'), /price was not changed/)

console.log('TSG recipe price notification checks passed.')
