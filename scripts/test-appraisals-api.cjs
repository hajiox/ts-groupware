const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
let current = null, conflict = false, dbCalls = 0
const rpcCalls = []
const users = [
  {id:id(1),role:'admin',status:'approved',real_name:'管理者A'},
  {id:id(2),role:'admin',status:'approved',real_name:'管理者B'},
  {id:id(3),role:'member',status:'approved',real_name:'対象A'},
  {id:id(4),role:'member',status:'approved',real_name:'対象B'},
  {id:id(5),role:'executive',status:'approved',real_name:'役員テスト'},
]
const tables = {
  gw_users:users,
  gw_payroll_employees:[{id:id(13),user_id:id(3),payroll_status:'active'},{id:id(14),user_id:id(4),payroll_status:'active'}],
  gw_appraisal_assignments:[{reviewer_id:id(1),employee_id:id(13)},{reviewer_id:id(2),employee_id:id(14)}],
  gw_employee_appraisals:[{id:id(20),reviewer_id:id(1),employee_id:id(13),period_month:'2026-09-01'},{id:id(21),reviewer_id:id(2),employee_id:id(14),period_month:'2026-09-01'}],
}
const client = {
  from(table) { dbCalls++; let rows = [...tables[table]]; return { select(){return this},eq(k,v){rows=rows.filter(r=>r[k]===v);return this},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)} } },
  async rpc(name,args) { rpcCalls.push({name,args}); return conflict ? {error:{message:'APPRAISAL_CONFLICT'},data:null} : {data:{version:1,reviewer_id:args.p_reviewer},error:null} },
}
const cache = {}
function load(file) {
  if (cache[file]) return cache[file]
  const mod={exports:{}}
  const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const localRequire=name=> {
    if(name==='next/server') return {NextResponse:{json:(body,options)=>new Response(JSON.stringify(body),{status:options?.status||200,headers:options?.headers})}}
    if(name==='@/lib/session') return {getUserSession:async()=>current}
    if(name==='@/lib/supabase/admin') return {adminClient:client}
    if(name==='./user-roles') return load('lib/user-roles.ts')
    if(name.startsWith('@/')) return load(name.slice(2)+'.ts')
    return require(name)
  }
  new Function('module','exports','require',output)(mod,mod.exports,localRequire)
  return cache[file]=mod.exports
}
const api=load('app/api/admin/appraisals/route.ts')
const {emptyAppraisalRatings,emptyAppraisalTalkChecklist}=load('lib/appraisals.ts')
const get=()=>api.GET({nextUrl:new URL('http://test/api/admin/appraisals?month=2026-09')})
const input=()=>({employeeId:id(13),month:'2026-09',assessedOn:'2026-09-11',ratings:emptyAppraisalRatings(),talkChecklist:emptyAppraisalTalkChecklist(),version:0,status:'draft'})
const post=body=>api.POST({text:async()=>JSON.stringify(body)})
async function run() {
  assert.equal((await get()).status,401); assert.equal(dbCalls,0)
  current=users[2]; assert.equal((await post(input())).status,403); assert.equal(dbCalls,0)
  current={...users[0],real_name:'TSG君'}; assert.equal((await get()).status,403)
  current=users[0]
  const response=await get(); assert.equal(response.headers.get('cache-control'),'private, no-store')
  const data=await response.json(); assert.equal(data.employees.length,1); assert.equal(data.records.length,1); assert.equal(data.records[0].reviewer_id,id(1));assert.deepEqual(data.reviewers,[])
  assert.equal((await post({...input(),employeeId:id(14)})).status,403)
  assert.equal((await post({...input(),action:'assign',reviewerId:id(1)})).status,403)
  assert.equal(rpcCalls.length,0)
  assert.equal((await post({...input(),reviewerId:id(2)})).status,200)
  assert.equal(rpcCalls[0].args.p_reviewer,id(1))
  assert.equal(rpcCalls[0].args.p_talk_checklist.harassment,false)
  assert.equal((await post({...input(),talkChecklist:{}})).status,400)
  assert.equal((await post({...input(),status:'completed'})).status,400)
  conflict=true; assert.equal((await post(input())).status,409);conflict=false
  current=users[4];const all=await (await get()).json();assert.equal(all.employees.length,0);assert.equal(all.assignableEmployees.length,2);assert.equal(all.records.length,2)
  current={...users[0],status:'pending'};assert.equal((await get()).status,403)
  console.log('Appraisal API: authentication, scope, checklist RPC, malformed input, completion and conflict passed')
}
run().catch(e=>{console.error(e);process.exitCode=1})
