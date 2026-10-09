const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const cache={}
function load(file){
  if(cache[file])return cache[file]
  const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
  const mod={exports:{}}
  new Function('module','exports','require',output)(mod,mod.exports,name=>name.startsWith('@/')?load(name.replace('@/','')+'.ts'):require(name))
  return cache[file]=mod.exports
}
const {calculatePayrollFromLabor,DEFAULT_ATTENDANCE_CALCULATION_POLICY}=load('lib/payroll-calculation.ts')
const {comparePayrollMailEmployee}=load('lib/payroll-mail-comparison.ts')
const item=(code,itemType,extra)=>({code,itemType,taxable:itemType==='earning',amount:0,minutes:null,days:null,rate:null,...extra})
const profile={id:'old',employee_id:'fixture',effective_from:'2026-09-01',calculation_type:'hourly',hourly_rate:1000,source_snapshot:{base_payment_amount:8000,work_minutes:480,payment_total:8000,deduction_total:400},deduction_snapshot:{income_tax:400}}
const labor={paymentTotal:9600,netPayment:9500,deductionTotal:100,nonTaxablePaymentTotal:0,items:[item('regular_salary','earning',{rate:1200}),item('base_salary','earning',{amount:9600}),item('work_minutes','attendance',{minutes:480}),item('attendance_days','attendance',{days:1}),item('income_tax','deduction',{amount:100})]}
const input={employeeId:'fixture',labor,profile,punches:[],paidLeave:[],policy:DEFAULT_ATTENDANCE_CALCULATION_POLICY}
const compare=overrides=>comparePayrollMailEmployee({...input,...overrides})
const initial=JSON.stringify({profile,labor})
assert.equal(compare().status,'matched','declared new rate overrides stale inferred rate')
assert.equal(compare().operational.reason,'attendance_missing','physical deficiency is separate')
assert.equal(compare({profile:null}).status,'matched','new hire with declared hourly rate')
assert.equal(compare({paidLeave:[{leave_date:'2026-09-01',leave_unit:'full_day',requested_days:1,payable_minutes_snapshot:480,paid_wage_amount:9600}]}).paymentDelta,0,'labor hours already include leave')
for(const field of ['paymentTotal','netPayment','deductionTotal'])assert.equal(compare({labor:{...labor,[field]:labor[field]+1}}).status,'mismatch',field+' is independently checked')
for(const field of ['paymentTotal','netPayment','deductionTotal','nonTaxablePaymentTotal'])assert.equal(compare({labor:{...labor,[field]:NaN}}).reason,'invalid_calculation',field+' requires a finite value')
assert.equal(compare({labor:{...labor,items:labor.items.map(row=>row.code==='base_salary'?{...row,amount:9601}:row)}}).status,'mismatch','base item tampering is visible even with unchanged total')
assert.equal(compare({labor:{...labor,items:labor.items.filter(row=>row.code!=='work_minutes')}}).reason,'labor_attendance_missing')
const zero={...labor,paymentTotal:0,netPayment:0,deductionTotal:0,items:[item('regular_salary','earning',{rate:1200}),item('base_salary','earning',{amount:0}),item('work_minutes','attendance',{minutes:0})]}
assert.equal(compare({labor:zero}).status,'matched','explicit zero hours and wages are valid')
const fixed={...profile,calculation_type:'monthly_fixed',monthly_base_amount:100000}
const monthly={...labor,paymentTotal:100000,netPayment:99900,items:[item('base_salary','earning',{amount:100000}),item('income_tax','deduction',{amount:100})]}
assert.equal(compare({profile:fixed,labor:monthly}).status,'matched','fixed salary needs no punches')
const overtime={...fixed,calculation_type:'monthly_with_overtime',source_snapshot:{weekday_saturday_overtime_hourly_rate:1435.2,sunday_overtime_hourly_rate:1550}}
const withOT={...monthly,paymentTotal:106458,netPayment:106358,items:[...monthly.items,item('weekday_saturday_overtime_minutes','attendance',{minutes:270}),item('weekday_saturday_overtime','earning',{amount:6458})]}
assert.equal(compare({profile:overtime,labor:withOT}).status,'matched','round old unit rate before hours')
assert.equal(compare({profile:overtime,labor:{...withOT,items:withOT.items.map(row=>row.code==='weekday_saturday_overtime'?{...row,amount:6459}:row)}}).status,'mismatch','OT target amount never defines its rate')
assert.equal(compare({profile:{...overtime,source_snapshot:{}},labor:withOT}).reason,'overtime_settings_missing','no target amount fitting')
const changedSalary={...withOT,items:withOT.items.map(row=>row.code==='base_salary'?{...row,amount:110000}:row),paymentTotal:116458,netPayment:116358}
assert.equal(compare({profile:overtime,labor:changedSalary}).status,'mismatch','unknown salary change remains visible')
const deductions=calculatePayrollFromLabor(profile,{...labor,items:[...labor.items.filter(row=>row.itemType!=='deduction'),item('social_insurance_total','deduction',{amount:10000}),item('employment_insurance','deduction',{amount:600})],deductionTotal:10000})
assert.equal(deductions.calculated.deductionTotal,10000,'social subtotal is not added to its components again')
assert.equal(JSON.stringify({profile,labor}),initial,'settings and original remain immutable')
console.log('Accountant-input formula, declared wages, known OT rounding, one-yen mutation detection, missing inputs, fixed salary/new hire/zero, leave and separate physical trial passed.')
