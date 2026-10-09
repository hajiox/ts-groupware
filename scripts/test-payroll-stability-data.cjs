const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const {NextRequest}=require('next/server')
const fixtures={
  gw_payroll_periods:[{id:'period',payroll_month:'2026-10-01',payroll_kind:'monthly'}],
  gw_payroll_employee_results:[{id:'result',employee_id:'employee',payroll_period_id:'period',payment_total:1000,net_payment:1000,deduction_total:0,non_taxable_payment_total:0}],
  gw_payroll_items:[{id:'base',code:'base_salary',item_type:'earning',taxable:true},{id:'rate',code:'regular_salary',item_type:'earning',taxable:true},{id:'time',code:'work_minutes',item_type:'attendance',taxable:false}],
  gw_payroll_result_items:[{id:'1',payroll_result_id:'result',payroll_item_id:'base',amount:1000,rate:null,minutes:null,days:null},{id:'2',payroll_result_id:'result',payroll_item_id:'rate',amount:0,rate:1000,minutes:null,days:null},{id:'3',payroll_result_id:'result',payroll_item_id:'time',amount:0,rate:null,minutes:60,days:null}],
  gw_payroll_calculation_profiles:[],gw_payroll_mail_jobs:[],
}
let fail=false,queries=0
class Query{
  constructor(table){this.table=table;this.filters=[];this.start=0;this.end=999;this.maximum=Infinity}
  select(){return this}order(){return this}eq(k,v){this.filters.push(r=>r[k]===v);return this}
  in(k,values){this.filters.push(r=>values.includes(r[k]));return this}lte(k,v){this.filters.push(r=>r[k]<=v);return this}
  limit(n){this.maximum=n;return this}range(a,b){this.start=a;this.end=b;return this}
  then(resolve,reject){queries++;return Promise.resolve(fail?{data:null,error:new Error('unavailable')}:{data:fixtures[this.table].filter(r=>this.filters.every(f=>f(r))).slice(this.start,Math.min(this.end+1,this.maximum)),error:null}).then(resolve,reject)}
}
const cache={};function load(file,mocks={}){if(cache[file]&&!Object.keys(mocks).length)return cache[file];const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;new Function('module','exports','require',code)(mod,mod.exports,name=>Object.hasOwn(mocks,name)?mocks[name]:name.startsWith('@/')?load(name.replace('@/','')+'.ts'):require(name));if(!Object.keys(mocks).length)cache[file]=mod.exports;return mod.exports}
cache['lib/supabase/admin.ts']={adminClient:{from:table=>new Query(table)}}
const {loadPayrollRuleStability}=load('lib/payroll-rule-stability-data.ts')
async function main(){
  const before=JSON.stringify(fixtures)
  const stored=await loadPayrollRuleStability()
  assert.equal(stored.status,'completed');assert.equal(stored.periodCount,1);assert.equal(stored.engineChecks.length,1)
  const pending={employeeId:'employee',labor:{employeeName:'not part of mathematical input',paymentTotal:1000,netPayment:1000,deductionTotal:0,nonTaxablePaymentTotal:0,items:fixtures.gw_payroll_result_items.map(i=>{const d=fixtures.gw_payroll_items.find(d=>d.id===i.payroll_item_id);return{code:d.code,itemType:d.item_type,taxable:d.taxable,amount:i.amount,rate:i.rate,minutes:i.minutes,days:i.days,name:'ignored',sortOrder:42}})}}
  const importing=await loadPayrollRuleStability({month:'2026-10-01',pending:[pending]})
  assert.equal(stored.sourceFingerprint,importing.sourceFingerprint,'pending parser metadata must not alter saved mathematical fingerprints')
  assert.deepEqual(stored.engineChecks,importing.engineChecks,'imported and stored input must be identical')
  fixtures.gw_payroll_mail_jobs.push({created_at:'2026-10-09T00:00:00Z',status:'imported',stability:{version:stored.version,engineChecks:stored.engineChecks}})
  assert.equal((await loadPayrollRuleStability()).totals.engineChanges,0)
  assert.equal((await loadPayrollRuleStability()).baselineComparedChecks,1)
  fixtures.gw_payroll_mail_jobs[0].stability.engineChecks=[{...stored.engineChecks[0],resultFingerprint:'prior-output'}]
  assert.equal((await loadPayrollRuleStability()).totals.engineChanges,1,'same-input prior output differences propagate into live audit')
  fixtures.gw_payroll_mail_jobs.length=0
  assert.equal(JSON.stringify(fixtures),before,'read-only analysis preserves source data')
  fixtures.gw_payroll_employee_results.push({...fixtures.gw_payroll_employee_results[0],id:'duplicate'})
  await assert.rejects(()=>loadPayrollRuleStability(),/Duplicate/);fixtures.gw_payroll_employee_results.pop()
  fail=true;await assert.rejects(()=>loadPayrollRuleStability(),/unavailable/);fail=false
  await assert.rejects(()=>loadPayrollRuleStability({month:'bad'}),/Invalid/)
  await assert.rejects(()=>loadPayrollRuleStability({pending:[pending]}),/require/)
  let user=null,allowed=false,loads=0
  const route=load('app/api/admin/payroll/stability/route.ts',{'@/lib/session':{getUserSession:async()=>user},'@/lib/management-permissions':{getManagementPermissions:()=>({canViewPayroll:allowed})},'@/lib/payroll-rule-stability-data':{loadPayrollRuleStability:async()=>{loads++;if(fail)throw new Error('private error');return stored}}})
  const request=()=>new NextRequest('https://fixture.invalid/api/admin/payroll/stability')
  assert.equal((await route.GET(request())).status,401);user={id:'user'}
  assert.equal((await route.GET(request())).status,403);assert.equal(loads,0,'no payroll reads before permission check')
  allowed=true;assert.equal((await route.GET(new NextRequest(request().url+'?payrollMonth=bad'))).status,400)
  const response=await route.GET(request());assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/)
  fail=true;const unavailable=await route.GET(request());assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes('private error'))
  assert.ok(queries>0)
  console.log('Payroll stability history, immutable pending/stored fingerprints, baseline drift, duplicate/failure handling, permission-before-read and no-cache API passed.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
