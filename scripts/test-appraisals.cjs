const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const source = fs.readFileSync('lib/appraisals.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const mod = { exports: {} }
new Function('exports', 'require', 'module', compiled)(mod.exports, require, mod)
const { APPRAISAL_ITEMS, APPRAISAL_TALK_ITEMS, emptyAppraisalRatings, emptyAppraisalTalkChecklist, validateAppraisalInput: validate, validAppraisalDate } = mod.exports
const input = () => ({ month: '2026-09', assessedOn: '2026-09-11', version: 0, status: 'draft', ratings: emptyAppraisalRatings(), talkChecklist: emptyAppraisalTalkChecklist() })
assert.equal(APPRAISAL_ITEMS.length, 10)
assert.equal(APPRAISAL_TALK_ITEMS.length, 5)
assert.deepEqual(APPRAISAL_ITEMS.map(i => i.priority), [15,10,5,15,15,5,5,5,5,20])
assert.equal(Object.values(validate(input()).ratings).filter(r => r.score === null).length, 10)
assert.deepEqual(validate(input()).talkChecklist, {company_teamwork:false,company_skills:false,company_cost:false,requests:false,harassment:false})
const checked = input(); checked.talkChecklist.harassment = true
assert.equal(validate(checked).talkChecklist.harassment, true)
assert.throws(() => validate({ ...input(), status: 'completed' }), /全10項目/)
const completed = input(); completed.status = 'completed'
Object.values(completed.ratings).forEach((r, i) => { r.score = i % 5 + 1; r.comment = ' 行動の例\n次回の課題 '; })
assert.equal(validate(completed).ratings.teamwork.comment, '行動の例\n次回の課題')
for (const score of [0,6,2.5,'3',undefined,NaN]) {
  const bad = input(); bad.ratings.teamwork.score = score
  assert.throws(() => validate(bad))
}
for (const date of ['2026-02-29','2026-13-01','invalid']) assert.equal(validAppraisalDate(date), false)
assert.equal(validAppraisalDate('2028-02-29'), true)
for (const [key,value] of [['month','2026-13'],['version',-1],['version',1.2],['status','other'],['ratings',[]]]) assert.throws(() => validate({...input(),[key]:value}))
for (const value of [null,[],{company_teamwork:true}, {...emptyAppraisalTalkChecklist(),harassment:'yes'}, {...emptyAppraisalTalkChecklist(),extra:false}]) assert.throws(() => validate({...input(),talkChecklist:value}))
const missing = input(); delete missing.ratings.teamwork; assert.throws(() => validate(missing))
const extra = input(); extra.ratings.other = { score:3,comment:'' }; assert.throws(() => validate(extra))
const long = input(); long.ratings.teamwork.comment = 'a'.repeat(2001); assert.throws(() => validate(long))
const separate = emptyAppraisalRatings(); separate.teamwork.score = 5
assert.equal(separate.shift.score, null)
assert.equal(emptyAppraisalRatings().teamwork.score, null)
console.log('Appraisal validation: ratings, 5 interview checks, dates, comments and malformed inputs passed')
