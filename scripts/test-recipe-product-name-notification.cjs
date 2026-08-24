const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'recipe-product-name-change-post.ts'), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, require)

const id = loaded.exports.recipeProductNameChangePostId('revision-id')
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.equal(loaded.exports.recipeProductNameChangePostId('revision-id'), id)

const content = loaded.exports.buildRecipeProductNameChangeContent({
  recipeId: 'recipe-id', recipeName: '商品\nA', previousProductName: '旧商品名', newProductName: '新商品名',
}, 'revision-id')
assert.match(content, /【EC用商品名変更】/)
assert.match(content, /@フロア/)
assert.match(content, /変更前: 旧商品名/)
assert.match(content, /変更後: 新商品名/)
assert.doesNotMatch(content, /商品\nA/)

const batch = loaded.exports.buildRecipeProductNameBatchChangeContent({ items: [
  { recipeId: 'a', recipeName: '商品A', previousProductName: '旧A', newProductName: '新A' },
  { recipeId: 'b', recipeName: '商品B', previousProductName: '旧B', newProductName: '新B' },
] }, 'batch:batch-id')
assert.match(batch, /【EC用商品名一括変更】/)
assert.match(batch, /2商品のEC用商品名変更が完了しました。/)
assert.equal((batch.match(/@フロア/g) || []).length, 1)
assert.throws(() => loaded.exports.buildRecipeProductNameBatchChangeContent({ items: [] }, 'empty'), /items is invalid/)

console.log('TSG recipe product name notification checks passed.')
