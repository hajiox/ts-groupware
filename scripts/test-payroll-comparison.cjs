const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const mod = { exports: {} }
  new Function('exports', output)(mod.exports)
  return mod.exports
}
const { calculatePayroll } = load('lib/payroll-calculation.ts')
const { comparisonPaidLeave, payrollAmountDelta } = load('lib/payroll-comparison.ts')
const profile = {
  calculation_type: 'hourly', hourly_rate: 1000,
  source_snapshot: { base_payment_amount: 100000, work_minutes: 6000, payment_total: 100000, deduction_total: 5000, employment_insurance: 500 },
  deduction_snapshot: { employment_insurance: 500, resident_tax: 4500 },
}
const laborHours = { workDays: 20, workMinutes: 6000, weekdaySaturdayOvertimeMinutes: 0, sundayOvertimeMinutes: 0, daily: [] }
const leave = { days: 1, minutes: 480, amount: 8000 }
assert.equal(calculatePayroll(profile, laborHours, leave).paymentTotal, 108000, 'reproduce old double addition')
for (const source of ['labor_result', 'labor_snapshot']) {
  const result = calculatePayroll(profile, laborHours, comparisonPaidLeave(source, leave))
  assert.equal(result.paymentTotal, 100000)
  assert.equal(result.netPayment, 95000)
  assert.equal(result.paidLeaveAmount, 0, 'no separately added leave in source reproduction')
}
const punches = { ...laborHours, workDays: 19, workMinutes: 5520 }
const punchResult = calculatePayroll(profile, punches, comparisonPaidLeave('punch', leave))
assert.deepEqual(punchResult, calculatePayroll(profile, punches, leave), 'physical-punch calculation unchanged')
assert.equal(punchResult.paymentTotal, 100000)
assert.equal(punchResult.paidLeaveAmount, 8000)
const noLeave = { days: 0, minutes: 0, amount: 0 }
assert.deepEqual(calculatePayroll(profile, laborHours, comparisonPaidLeave('labor_result', noLeave)), calculatePayroll(profile, laborHours, noLeave))
for (const kind of ['monthly_fixed', 'officer_fixed', 'monthly_with_overtime']) {
  const monthly = { ...profile, calculation_type: kind, monthly_base_amount: 100000 }
  const before = calculatePayroll(monthly, laborHours, leave)
  const after = calculatePayroll(monthly, laborHours, comparisonPaidLeave('labor_result', leave))
  assert.equal(after.paymentTotal, before.paymentTotal)
  assert.equal(after.netPayment, before.netPayment)
}
assert.equal(comparisonPaidLeave('none', leave), undefined)
assert.equal(payrollAmountDelta(100000, null), null)
assert.equal(payrollAmountDelta(100000, 0), 100000)
console.log('Labor-result/snapshot reproduction, separate punch leave wages, no-leave/monthly regressions and missing results passed.')
