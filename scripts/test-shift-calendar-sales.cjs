const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename)
const { SHIFT_EC_SALE_OPTIONS: options, isShiftEcSaleOperational, shiftEcSalePickerOptions, visibleShiftEcSaleIds, shiftEcSaleLabels } = require('../lib/shift-sales.ts')
const { calendarSalesByDay, resolveCalendarSale, reconcileCalendarSales } = require('../lib/shift-calendar-sales.ts')
const sale = resolveCalendarSale('楽天スーパーSALE（設定済み）', options)
assert.equal(sale.id, 'rakuten_super_sale')
assert.equal(resolveCalendarSale('Yahoo5のつく日（設定済み）', options).id, 'yahoo_five_day')
assert.equal(resolveCalendarSale('SNS改革報告', options), null)
assert.equal(resolveCalendarSale('楽天スーパーSALE', [{ ...sale, is_active: false }]), null)
assert.equal(resolveCalendarSale('楽天スーパーSALE', [{ ...sale, label: '楽天特別セール' }]).label, '楽天特別セール')
assert.equal(resolveCalendarSale('BASE真ん中市（設定済み）', options).id, resolveCalendarSale('BASE真ん中市', options).id)
const events = [{ title: '楽天スーパーSALE', starts_at: '2026-09-04T00:00:00+09:00', ends_at: '2026-09-12T00:00:00+09:00', all_day: true }]
const days = calendarSalesByDay(events, options, '2026-09-01', '2026-09-15')
assert.equal(Object.keys(days).filter(d => Object.keys(days[d]).length).length, 8)
assert.deepEqual(days['2026-09-12'], {})
const timed = calendarSalesByDay([{ ...events[0], all_day: false, starts_at: '2026-09-04T20:00:00+09:00', ends_at: '2026-09-06T01:59:00+09:00' }], options, '2026-09-04', '2026-09-06')
assert.deepEqual(timed['2026-09-04'][sale.id], { start_time: '20:00', end_time: null })
assert.deepEqual(timed['2026-09-05'][sale.id], { start_time: null, end_time: null })
assert.deepEqual(timed['2026-09-06'][sale.id], { start_time: null, end_time: '01:59' })
assert.equal(Object.keys(calendarSalesByDay([...events, ...events], options, '2026-09-05', '2026-09-05')['2026-09-05']).length, 1)
const next = timed['2026-09-04']
const initial = reconcileCalendarSales(['manual'], {}, {}, next)
assert.deepEqual(initial.ec_sale_tags, ['manual', sale.id])
assert.deepEqual(reconcileCalendarSales(initial.ec_sale_tags, initial.ec_sale_times, initial.calendar_sale_state, next), initial)
const removed = reconcileCalendarSales(['manual'], {}, initial.calendar_sale_state, next)
assert.deepEqual(removed.ec_sale_tags, ['manual'])
assert.deepEqual(reconcileCalendarSales(removed.ec_sale_tags, removed.ec_sale_times, removed.calendar_sale_state, next), removed)
const overridden = reconcileCalendarSales(initial.ec_sale_tags, { [sale.id]: { start_time: '19:00', end_time: null } }, initial.calendar_sale_state, next)
assert.equal(overridden.ec_sale_times[sale.id].start_time, '19:00')
assert.deepEqual(overridden.calendar_sale_state.automatic, {})
const cancelled = reconcileCalendarSales(initial.ec_sale_tags, initial.ec_sale_times, initial.calendar_sale_state, {})
assert.deepEqual(cancelled.ec_sale_tags, ['manual'])
const existingManual = reconcileCalendarSales([sale.id], { [sale.id]: { start_time: '10:00', end_time: null } }, {}, next)
assert.equal(existingManual.ec_sale_times[sale.id].start_time, '10:00')
assert.deepEqual(existingManual.calendar_sale_state.automatic, {})
for (const label of ['AmazonスマイルSALE', '楽天スーパーSALE', 'Yahoo超PayPay祭り', 'BASE真ん中市']) {
  assert.ok(resolveCalendarSale(label, options, '2026-10-01'), `${label} remains operational`)
}
for (const label of ['メルカリ月末市', 'Mercari Shops SALE', 'Qoo10メガ割セール', 'TikTok Shopセール', 'TikTokショップSALE']) {
  assert.ok(resolveCalendarSale(label, options, '2026-09-30'), `${label} keeps history`)
  assert.equal(resolveCalendarSale(label, options, '2026-10-01'), null, `${label} stops at cutoff`)
}
for (const label of ['MakeShopセール', 'makeshop SALE', 'メイクショップSALE']) {
  assert.equal(resolveCalendarSale(label, options, '2026-10-01'), null, `${label} is preparing`)
}
for (const label of ['TikTok動画撮影', 'TikTok SNSセール告知', '社内：メルカリのセール研修', '商品A セール']) {
  assert.equal(isShiftEcSaleOperational({ id: 'custom', label }, '2026-10-01'), true, `${label} is not a shop operation`)
}
const retired = resolveCalendarSale('メルカリ月末市', [], '2026-09-30')
assert.equal(resolveCalendarSale(retired.label, [retired], '2026-10-01'), null)
const crossing = [{ title: retired.label, starts_at: '2026-09-30T00:00:00+09:00', ends_at: '2026-10-02T00:00:00+09:00', all_day: true }]
const sourceBefore = JSON.stringify(crossing)
const crossingDays = calendarSalesByDay(crossing, [retired], '2026-09-30', '2026-10-01')
assert.ok(crossingDays['2026-09-30'][retired.id])
assert.deepEqual(crossingDays['2026-10-01'], {})
assert.equal(JSON.stringify(crossing), sourceBefore)
const retiredState = { automatic: { [retired.id]: { start_time: null, end_time: null } }, suppressed: [] }
const saved = reconcileCalendarSales([retired.id], {}, retiredState, {}, [retired.id])
assert.deepEqual(saved.ec_sale_tags, [retired.id])
assert.deepEqual(saved.calendar_sale_state, retiredState)
assert.deepEqual(visibleShiftEcSaleIds(saved.ec_sale_tags, [retired], '2026-10-01', [retired.id]), [])
assert.deepEqual(shiftEcSaleLabels(saved.ec_sale_tags, [retired], {}, '2026-10-01', [retired.id]), [])
assert.deepEqual(visibleShiftEcSaleIds(saved.ec_sale_tags, [retired], '2026-09-30', [retired.id]), [retired.id])
assert.deepEqual(visibleShiftEcSaleIds(saved.ec_sale_tags, [retired], '2026-10-01', []), [retired.id], 'saved manual notes remain visible')
assert.deepEqual(shiftEcSalePickerOptions([retired], '2026-10-01', []), [])
assert.deepEqual(shiftEcSalePickerOptions([retired], '2026-10-01', [retired.id], [retired.id]), [])
assert.deepEqual(shiftEcSalePickerOptions([retired], '2026-10-01', [retired.id]), [retired])
assert.deepEqual(shiftEcSalePickerOptions([retired], '2026-09-30', []), [retired])
assert.deepEqual(reconcileCalendarSales([], {}, retiredState, {}, [retired.id]).ec_sale_tags, [], 'explicit removal is not restored')
console.log('Calendar sales, date boundaries, retired shops, preparing MakeShop, preserved originals/manual/automatic notes and picker/display policy passed.')
