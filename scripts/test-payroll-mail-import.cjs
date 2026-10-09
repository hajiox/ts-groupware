const assert=require('node:assert/strict')
const fs=require('node:fs')
const crypto=require('node:crypto')
const ts=require('typescript')
const {NextRequest,NextResponse}=require('next/server')
function load(file,mocks={}){
  const out=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText
  const loaded={exports:{}}
  new Function('module','exports','require',out)(loaded,loaded.exports,name=>{
    if(Object.hasOwn(mocks,name))return mocks[name]
    if(name.startsWith('@/'))throw new Error(`Unexpected dependency: ${name}`)
    return require(name)
  })
  return loaded.exports
}
const calculation=load('lib/payroll-calculation.ts')
const comparison=load('lib/payroll-mail-comparison.ts',{'@/lib/payroll-calculation':calculation})
const policy={roundingUnitMinutes:1,clockInMethod:'none',clockOutMethod:'none',totalMinutesMethod:'none',breakRules:[{minWorkMinutesExclusive:-1,maxWorkMinutesInclusive:null,breakMinutes:0}]}
const employee={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employee_code:'901',display_name:'検証社員',real_name:'検証社員',user_id:null,payroll_status:'active',raw_payload:{}}
const profile={id:'profile-old',employee_id:employee.id,effective_from:'2026-08-01',calculation_type:'hourly',hourly_rate:1000,
  deduction_snapshot:{},source_snapshot:{source:'labor_payroll_zip',payroll_month:'2026-08-01',deduction_total:0}}
const punches=[{employee_id:employee.id,is_voided:false,punch_type:'clock_in',work_date:'2026-09-01',punched_at:'2026-09-01T00:00:00Z'},
  {employee_id:employee.id,is_voided:false,punch_type:'clock_out',work_date:'2026-09-01',punched_at:'2026-09-01T08:00:00Z'}]
const labor={employeeCode:'901',employeeName:'検証社員',taxablePaymentTotal:8000,nonTaxablePaymentTotal:0,paymentTotal:8000,
  socialInsuranceTotal:0,deductionTotal:0,taxableIncome:8000,netPayment:8000,cashPayment:0,transferPayment:8000,
  dependentsCount:0,taxTableCategory:'甲',sourceSheet:'検証',items:[{code:'base_salary',name:'基本給',itemType:'earning',taxable:true,amount:8000,minutes:null,days:null,rate:null,sortOrder:10,rawValue:8000}]}
function compare(extra={}){return comparison.comparePayrollMailEmployee({employeeId:employee.id,labor,profile,punches,paidLeave:[],policy,...extra})}
assert.equal(compare().status,'matched')
assert.equal(compare({profile:{...profile,hourly_rate:1200}}).status,'mismatch')
assert.equal(compare({punches:[]}).reason,'attendance_missing')
assert.equal(compare({punches:[punches[0]]}).reason,'attendance_incomplete')
assert.equal(compare({profile:null}).status,'unverified')
assert.equal(compare({profile:{...profile,source_snapshot:{}}}).reason,'deduction_settings_missing')
assert.equal(compare({paidLeave:[{leave_date:'2026-09-01',leave_unit:'full_day',requested_days:1,payable_minutes_snapshot:480,paid_wage_amount:8000}]}).reason,'paid_leave_conflict')
assert.equal(compare({labor:{...labor,items:[{code:'work_minutes',minutes:450}]}}).reason,'attendance_difference')
const current={...profile,id:'profile-current',effective_from:'2026-10-01',hourly_rate:1200,source_snapshot:{source:'labor_payroll_zip',payroll_month:'2026-10-01'}}
assert.equal(comparison.selectIndependentProfile([current,profile],employee.id,'2026-10-01').id,'profile-old')
assert.equal(comparison.selectIndependentProfile([current],employee.id,'2026-10-01'),null)
const profileBefore=JSON.stringify(profile)
compare()
assert.equal(JSON.stringify(profile),profileBefore)

const jobs=new Map(),sources=new Map(),events=[]
let driveCalls=0,parserCalls=0,dmCalls=0,dmFails=true,archiveFails=false
const forceReview=false
const recipient={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',real_name:'佐藤 正彦',display_name:'検証役員',role:'executive'}
class Query{
  constructor(table){this.table=table;this.filters=[];this.from=0;this.to=999;this.mutation=null}
  select(){return this}eq(k,v){this.filters.push([k,v]);return this}in(){return this}lte(){return this}gte(){return this}order(){return this}
  limit(){return this}range(from,to){this.from=from;this.to=to;return this}
  update(value){this.mutation=value;return this}maybeSingle(){this.isSingle=true;return this}single(){this.isSingle=true;return this}
  then(resolve,reject){return Promise.resolve().then(()=>{
    let rows=[]
    if(this.table==='gw_users')rows=[recipient]
    else if(this.table==='gw_payroll_mail_sources')rows=[...sources].map(([source_key,value])=>({source_key,...value}))
    else if(this.table==='gw_payroll_mail_jobs')rows=[...jobs.values()]
    else if(this.table==='gw_payroll_employees')rows=[employee]
    else if(this.table==='gw_payroll_calculation_profiles'){assert.equal(this.mutation,null);rows=[profile,current]}
    else if(this.table==='gw_attendance_punches')rows=punches
    else if(this.table==='gw_paid_leave_requests'||this.table==='gw_labor_source_documents')rows=[]
    else throw new Error(`Unexpected table ${this.table}`)
    rows=rows.filter(row=>this.filters.every(([k,v])=>row[k]===v || this.table==='gw_users'&&k==='status'))
    if(this.mutation){for(const row of rows)Object.assign(row,this.mutation);events.push('mark-report')}
    return{data:this.isSingle?rows[0]||null:rows.slice(this.from,this.to+1),error:null}
  }).then(resolve,reject)}
}
const adminClient={from:table=>new Query(table),async rpc(name,{p_payload:p}){
  assert.equal(name,'gw_receive_payroll_mail')
  events.push('transaction')
  const source=sources.get(p.sourceKey)
  if(source&&source.request_fingerprint!==p.fingerprint)return{data:null,error:{code:'23505'}}
  let job=source?jobs.get(source.job_id):[...jobs.values()].find(job=>job.idempotency_key===`zip:${p.sha256}:${p.payrollMonth}:${p.attendanceMonth}`)
  const duplicate=Boolean(job)
  if(!job){
    const review=Boolean(p.reviewReason||forceReview)
    job={id:crypto.randomUUID(),idempotency_key:p.mode==='review'?`review:${p.sourceKey}`:`zip:${p.sha256}:${p.payrollMonth}:${p.attendanceMonth}`,
      original_source_key:p.sourceKey,message_id:p.messageId,zip_sha256:p.sha256,payroll_month:p.payrollMonth,attendance_month:p.attendanceMonth,
      status:review?'needs_review':'imported',reason:p.reviewReason||null,batch_id:review?null:crypto.randomUUID(),comparison:p.comparison||{},
      report_content:review?p.reviewContent:p.reportContent,report_status:'pending'}
    if(p.mode==='import'&&!review){assert.equal(p.summary.profileUpdated,false);assert.equal(p.payDate,'2026-10-09');assert.equal(p.results.length,1)}
    jobs.set(job.id,job)
  }
  sources.set(p.sourceKey,{job_id:job.id,message_id:p.messageId,request_fingerprint:p.fingerprint})
  return{data:{...job,duplicate},error:null}
}}
const mocks={
  '@/app/api/integrations/tsa/direct-message/route':{POST:async request=>{
    dmCalls++;const body=await request.json()
    assert.equal(body.recipientName,'佐藤 正彦');assert.match(body.sourceKey,/^payroll-mail:[a-f0-9-]+:report:v1$/)
    assert.ok(!body.content.includes('検証社員'));assert.ok(!body.content.includes('8000'))
    if(dmFails)return NextResponse.json({ok:false},{status:503})
    return NextResponse.json({ok:true,recipient:{id:recipient.id},poster:{displayName:'TSG君'},post:{id:crypto.randomUUID(),content:body.content}},{status:201})
  }},
  '@/lib/supabase/admin':{adminClient},
  '@/lib/drive':{PayrollArchiveStorageError:class extends Error{},initializePayrollArchiveStorage:async()=>({folderId:'fixture-new-folder'}),checkPayrollArchiveStorage:async()=>true,uploadPayrollArchiveToDrive:async(_buffer,name)=>{driveCalls++;assert.match(name,/^給与メール_/);return{id:'private-fixture'}}},
  '@/lib/payroll-mail-archive':{parsePayrollMailArchive:async()=>{if(archiveFails)throw Error('secret employee amount must not escape');return{
    buffer:Buffer.from('validated'),payDate:'2026-10-09',statementWorkbook:'支給控除一覧表.xlsx',ledgerWorkbook:'賃金台帳.xlsx',
    entries:[{path:'支給控除一覧表.xlsx',name:'支給控除一覧表.xlsx',size:100,crc32:'01234567'}]}}},
  '@/lib/labor-payroll-zip':{parseLaborPayrollZip:async()=>{parserCalls++;return{results:[labor],totals:{employeeCount:1,paymentTotal:8000,deductionTotal:0,netPayment:8000}}},
    matchLaborPayrollEmployees:()=>[{result:labor,employee}]},
  '@/lib/supabase-pagination':{loadAllRows:async callback=>(await callback(0,999)).data},
  '@/lib/payroll-attendance-policy-data':{loadAttendanceCalculationPolicy:async date=>{assert.equal(date,'2026-09-30');return policy}},
  '@/lib/payroll-mail-comparison':comparison,
  '@/lib/user-roles':load('lib/user-roles.ts'),
}
const imported=load('lib/payroll-mail-import.ts',mocks)
const archive=Buffer.from('PK synthetic archive')
const raw={sourceKey:'fixture-source',messageId:'fixture-message',attachmentId:'fixture-attachment',fileName:'2026.10.zip',
  sha256:crypto.createHash('sha256').update(archive).digest('hex'),payrollMonth:'2026-10',attendanceMonth:'2026-09',receivedAt:'2026-10-08T08:00:00Z',
  sender:'tatuya.enokida@gmail.com',zipBase64:archive.toString('base64')}
assert.equal(imported.parsePayrollMailInput(raw).buffer.toString(),archive.toString())
for(const change of [{sender:'spoof@example.com'},{unknown:true},{attendanceMonth:'2026-08'},{sha256:'a'.repeat(64)},{zipBase64:'!!!!'},{payrollMonth:'2026-13'},{fileName:'../x.zip'}]){
  assert.throws(()=>imported.parsePayrollMailInput({...raw,...change}),error=>error instanceof imported.PayrollMailError)
}
assert.throws(()=>imported.parsePayrollMailInput({...raw,zipBase64:Buffer.alloc(3*1024*1024+1).toString('base64')}))
assert.throws(()=>imported.parsePayrollMailInput({action:'retry_report',sourceKey:'x',recipientName:'someone'}))
assert.throws(()=>imported.parsePayrollMailInput({action:'initialize_storage',folderId:'untrusted'}))
assert.deepEqual(imported.parsePayrollMailInput({action:'initialize_storage'}),{mode:'initialize_storage'})
assert.equal(imported.parsePayrollMailInput({status:'needs_review',sourceKey:'review',messageId:'fixture',sender:raw.sender,errorCode:'source_unavailable',receivedAt:''}).mode,'review')
async function main(){
  process.env.TSG_INTEGRATION_SECRET='synthetic-dm-secret'
  process.env.PAYROLL_MAIL_RECIPIENT_NAME='佐藤 正彦'
  let result=await imported.processPayrollMail(imported.parsePayrollMailInput(raw))
  assert.equal(result.status,'imported');assert.equal(result.report.status,'pending');assert.equal(result.counts.compared,1)
  assert.equal(driveCalls,1);assert.equal(parserCalls,1)
  dmFails=false
  result=await imported.processPayrollMail({mode:'retry_report',sourceKey:raw.sourceKey})
  assert.equal(result.report.status,'sent');assert.equal(driveCalls,1);assert.equal(parserCalls,1)
  const dmAfterSent=dmCalls
  result=await imported.processPayrollMail(imported.parsePayrollMailInput(raw))
  assert.equal(result.status,'duplicate');assert.equal(dmCalls,dmAfterSent);assert.equal(driveCalls,1)
  result=await imported.processPayrollMail(imported.parsePayrollMailInput({...raw,sourceKey:'fixture-forward',messageId:'forward-message'}))
  assert.equal(result.status,'duplicate');assert.equal(driveCalls,1);assert.equal(parserCalls,1)
  assert.equal((await imported.getPayrollMailReceipt('fixture-forward')).messageId,'forward-message')
  await assert.rejects(()=>imported.processPayrollMail(imported.parsePayrollMailInput({...raw,fileName:'changed.zip'})),error=>error.code==='source_conflict')
  archiveFails=true
  const other=Buffer.from('PK invalid fixture')
  result=await imported.processPayrollMail(imported.parsePayrollMailInput({...raw,sourceKey:'bad-archive',sha256:crypto.createHash('sha256').update(other).digest('hex'),zipBase64:other.toString('base64')}))
  assert.equal(result.status,'needs_review');assert.equal(result.batchId,null);assert.equal(driveCalls,1)
  assert.equal(JSON.stringify(profile),profileBefore)
  const route=load('app/api/integrations/doc-scanner/payroll-mail/route.ts',{'@/lib/payroll-mail-import':imported})
  process.env.TSG_PAYROLL_MAIL_SECRET='synthetic-dedicated-secret'
  const request=(body,headers={})=>new NextRequest('https://fixture.invalid/api/integrations/doc-scanner/payroll-mail',{
    method:'POST',body,headers:{'content-type':'application/json',...headers}})
  assert.equal((await route.POST(request('{}'))).status,401)
  assert.equal((await route.POST(request('{}',{'x-tsg-payroll-mail-secret':'synthetic-dm-secret'}))).status,401)
  assert.equal((await route.POST(request('{}',{'x-tsg-payroll-mail-secret':'synthetic-dedicated-secret','authorization':'Bearer different'}))).status,401)
  assert.equal((await route.POST(request('!!!',{'authorization':'Bearer synthetic-dedicated-secret'}))).status,400)
  assert.equal((await route.POST(request('{}',{'authorization':'Bearer synthetic-dedicated-secret','content-length':'4300001'}))).status,413)
  assert.equal((await route.POST(request(JSON.stringify({action:'retry_report',sourceKey:raw.sourceKey}),{'x-tsg-payroll-mail-secret':'synthetic-dedicated-secret'}))).status,200)
  const setup=await route.POST(request(JSON.stringify({action:'initialize_storage'}),{'x-tsg-payroll-mail-secret':'synthetic-dedicated-secret'}))
  assert.equal(setup.status,200);assert.deepEqual(await setup.json(),{ok:true,folderId:'fixture-new-folder'})
  assert.equal((await route.GET(new NextRequest('https://fixture.invalid/api/integrations/doc-scanner/payroll-mail?sourceKey=unknown',{headers:{authorization:'Bearer synthetic-dedicated-secret'}}))).status,404)
  console.log('Payroll independent comparison, strict envelope, auth boundary, stable source/hash, private archive, review, DM-only retry and no profile mutation passed.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
