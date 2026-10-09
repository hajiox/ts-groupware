const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

function evaluate(source, exportedNames) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  return new Function(`${output}\nreturn {${exportedNames.join(',')}};`)()
}

// Exercise the actual review functions without a database, user session or Next
// route import. TypeScript's syntax tree keeps this independent of line numbers.
const routePath = 'app/api/admin/payroll/diff/route.ts'
const routeSource = fs.readFileSync(routePath, 'utf8')
const syntax = ts.createSourceFile(routePath, routeSource, ts.ScriptTarget.Latest, true)
const names = new Set([
  'REVIEW_CHANGE_POINT_DEFINITIONS', 'yenText', 'addDeltaHint',
  'buildDifferenceHints', 'hasPayrollFormulaDifference', 'buildPayrollReview',
])
const declarations = syntax.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text)
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(syntax)))
  return false
}).map(statement => statement.getText(syntax)).join('\n')
const { buildPayrollReview, buildDifferenceHints, hasPayrollFormulaDifference } = evaluate(declarations, [
  'buildPayrollReview', 'buildDifferenceHints', 'hasPayrollFormulaDifference',
])
const { calculatePayrollFromLabor } = evaluate(fs.readFileSync('lib/payroll-calculation.ts', 'utf8').replace(/^export /gm, ''), ['calculatePayrollFromLabor'])

const item = (code, itemType, fields) => ({
  code, itemType, taxable: itemType === 'earning', amount: 0,
  minutes: null, days: null, rate: null, ...fields,
})
const profile = {
  calculation_type: 'monthly_with_overtime', monthly_base_amount: 100000,
  source_snapshot: { weekday_saturday_overtime_hourly_rate: 1000, sunday_overtime_hourly_rate: 1500 },
}
const labor = {
  paymentTotal: 102500, netPayment: 102500, deductionTotal: 0, nonTaxablePaymentTotal: 0,
  items: [
    item('base_salary', 'earning', { amount: 100000 }),
    item('weekday_saturday_overtime_minutes', 'attendance', { minutes: 60 }),
    item('sunday_overtime_minutes', 'attendance', { minutes: 60 }),
    item('weekday_saturday_overtime', 'earning', { amount: 1500 }),
    item('sunday_overtime', 'earning', { amount: 1000 }),
  ],
}
const reconstructed = calculatePayrollFromLabor(profile, labor)
assert.equal(reconstructed.calculated.paymentTotal, labor.paymentTotal)
assert.equal(reconstructed.componentDifference, true, 'swapped overtime components must remain a difference despite equal totals')
const breakdown = {
  baseAmount: 100000, overtimeAmount: 2500, taxableAdditions: 0,
  nonTaxableAmount: 0, deductionTotal: 0, hasItemDetails: true,
  earningItems: [], deductionItems: [], attendanceItems: [],
}
const row = {
  employeeName: '検証対象', hasLaborResult: true, hasProfile: true,
  calculationUnavailableReason: null, laborMatch: { matchedBy: 'direct' }, laborCandidates: [],
  laborBreakdown: breakdown, calculatedBreakdown: { ...breakdown },
  componentDifference: reconstructed.componentDifference,
  hasOperationalAttendanceDifference: false, operationalPaymentDelta: null,
  delta: { paymentTotal: 0, netPayment: 0 }, issue: '要確認',
}
assert.equal([row].filter(hasPayrollFormulaDifference).length, 1, 'summary mismatch predicate includes component differences')
const review = buildPayrollReview([row])
assert.equal(review.exactMatches, 0)
assert.equal(review.status, 'needs_changes')
assert.equal(review.unresolvedEmployees, 1)
assert.ok(review.changePoints.some(point => point.id === 'earning_components' && point.affectedEmployees === 1))
const hints = buildDifferenceHints({
  labor: {}, laborBreakdown: breakdown, calculatedBreakdown: breakdown,
  laborMatch: { matchedBy: 'direct' }, laborCandidates: [], profile,
  calculationUnavailableReason: null, componentDifference: true,
})
assert.ok(hints.some(hint => hint.includes('項目別金額に差')))
assert.ok(!hints.some(hint => hint.includes('主要内訳は一致')))

// Historical/manual rows have no reconstruction flag and retain their existing
// total-based review. Physical attendance differences stay informational.
const matched = { ...row, componentDifference: undefined, issue: '一致' }
assert.equal(buildPayrollReview([matched]).status, 'verified')
assert.equal(buildPayrollReview([matched]).exactMatches, 1)
const physical = { ...matched, hasOperationalAttendanceDifference: true, operationalPaymentDelta: 500, issue: '勤怠差' }
assert.equal(buildPayrollReview([physical]).status, 'verified')
assert.equal(buildPayrollReview([physical]).exactMatches, 1)
assert.equal(buildPayrollReview([physical]).attendanceDifferenceEmployees, 1)
const monetary = { ...matched, delta: { paymentTotal: 100, netPayment: 100 }, calculatedBreakdown: { ...breakdown, baseAmount: 100100 }, issue: '要確認' }
assert.equal(buildPayrollReview([monetary]).status, 'needs_changes')
assert.equal(buildPayrollReview([monetary]).exactMatches, 0)
assert.equal([monetary].filter(hasPayrollFormulaDifference).length, 1)
const blocked = { ...matched, calculatedBreakdown: null, calculationUnavailableReason: '不足', issue: '打刻なし' }
assert.equal(buildPayrollReview([blocked]).status, 'not_ready')
assert.equal(buildPayrollReview([blocked]).exactMatches, 0)
console.log('Payroll diff summary: offsetting overtime components, mismatch counts, review/hints, physical-only differences and historical manual rows passed.')
