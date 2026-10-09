const assert=require('node:assert/strict')
const fs=require('node:fs')
const ts=require('typescript')
const owner={type:'user',role:'owner',emailAddress:'fixture-owner@example.invalid'}
const actor={type:'user',role:'writer',emailAddress:'fixture-api@example.invalid'}
let folderPermissions,createdPermissions,folderMetadata,nextPageToken,created=0,trashed=0
function reset(){
  folderPermissions=[owner,actor];createdPermissions=[owner,actor];nextPageToken=undefined
  folderMetadata={mimeType:'application/vnd.google-apps.folder',trashed:false,capabilities:{canAddChildren:true}}
}
reset()
const drive={
  about:{get:async()=>({data:{user:{emailAddress:actor.emailAddress}}})},
  permissions:{list:async({fileId,fields})=>{
    assert.ok(fields.includes('nextPageToken'))
    return{data:{permissions:fileId==='fixture-private-folder'?folderPermissions:createdPermissions,nextPageToken}}
  }},
  files:{get:async({fields})=>{assert.ok(fields.includes('capabilities'));return{data:folderMetadata}},
    create:async({requestBody,fields})=>{assert.deepEqual(requestBody.parents,['fixture-private-folder']);assert.equal(fields,'id');created++;return{data:{id:'fixture-private-file'}}},
    update:async({fileId,requestBody})=>{assert.equal(fileId,'fixture-private-file');assert.equal(requestBody.trashed,true);trashed++;return{data:{}}}},
}
const google={auth:{OAuth2:class{setCredentials(){}}},drive:()=>drive}
const output=ts.transpileModule(fs.readFileSync('lib/drive.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText
const loaded={exports:{}}
new Function('module','exports','require',output)(loaded,loaded.exports,name=>name==='googleapis'?{google}:require(name))
const {checkPayrollArchiveStorage,uploadPayrollArchiveToDrive}=loaded.exports
process.env.GOOGLE_CLIENT_ID='fixture-client'
process.env.GOOGLE_CLIENT_SECRET='fixture-secret'
process.env.GOOGLE_DRIVE_REFRESH_TOKEN='fixture-refresh'
process.env.GOOGLE_PAYROLL_FOLDER_ID='fixture-private-folder'
async function main(){
  assert.equal(await checkPayrollArchiveStorage(),true)
  assert.deepEqual(await uploadPayrollArchiveToDrive(Buffer.from('fixture'),'fixture.zip'),{id:'fixture-private-file'})
  for(const permission of [{type:'anyone',role:'reader'},{type:'domain',role:'reader'},{type:'group',role:'reader'},
    {type:'user',role:'reader',emailAddress:'unrelated@example.invalid'}]){
    reset();folderPermissions.push(permission);const before=created
    await assert.rejects(()=>uploadPayrollArchiveToDrive(Buffer.from('fixture'),'fixture.zip'),/must be private/)
    assert.equal(created,before,'Unsafe folder must fail before upload')
  }
  reset();nextPageToken='more-sharing'
  await assert.rejects(()=>checkPayrollArchiveStorage(),/must be private/)
  reset();folderMetadata.capabilities.canAddChildren=false
  await assert.rejects(()=>checkPayrollArchiveStorage(),/private My Drive/)
  reset();folderMetadata.driveId='shared-drive'
  await assert.rejects(()=>checkPayrollArchiveStorage(),/private My Drive/)
  reset();folderMetadata.trashed=true
  await assert.rejects(()=>checkPayrollArchiveStorage(),/private My Drive/)
  reset();createdPermissions.push({type:'anyone',role:'reader'})
  const before=trashed
  await assert.rejects(()=>uploadPayrollArchiveToDrive(Buffer.from('fixture'),'fixture.zip'),/must be private/)
  assert.equal(trashed,before+1,'A permission race must remove the newly-created archive')
  reset();delete process.env.GOOGLE_PAYROLL_FOLDER_ID
  await assert.rejects(()=>checkPayrollArchiveStorage(),/not configured/)
  console.log('Payroll dedicated Drive folder, inherited/public/domain/group sharing rejection, write capability, pagination and post-upload verification passed.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
