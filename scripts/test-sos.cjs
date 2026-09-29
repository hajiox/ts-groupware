const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
function load(file,deps){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module,exports:module.exports,require:n=>{if(!(n in deps))throw Error(n);return deps[n]},console,process,Date,URL});return module.exports}
const reply={NextResponse:{json:(body,options)=>({body,status:options?.status||200})}};
async function run(){
  let sent=0;let subscriptions=[];let subscriptionError=null;let fail=false;
  const push=load('lib/web-push.ts',{'web-push':{setVapidDetails(){},async sendNotification(){sent++;if(fail)throw {statusCode:503}}},'@/lib/unread':{getUnreadSummary:async()=>({totalUnread:0})},'@/lib/supabase/admin':{adminClient:{from:()=>({select:()=>({eq:async()=>({data:subscriptions,error:subscriptionError})})})}}});
  assert.equal((await push.sendPushNotificationToUserWithResult('user',{title:'test',body:'test'})).outcome,'no_subscription');assert.equal(sent,0);
  subscriptionError={message:'offline'};assert.equal((await push.sendPushNotificationToUserWithResult('user',{})).outcome,'subscription_error');subscriptionError=null;
  subscriptions=[{id:'one',endpoint:'test',p256dh:'test',auth:'test'}];delete process.env.VAPID_PRIVATE_KEY;delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  assert.equal((await push.sendPushNotificationToUserWithResult('user',{})).outcome,'not_configured');
  process.env.VAPID_PRIVATE_KEY='mock';process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY='mock';
  assert.equal((await push.sendPushNotificationToUserWithResult('user',{})).accepted,1);fail=true;
  assert.equal((await push.sendPushNotificationToUserWithResult('user',{})).outcome,'failed');

  for(const user of [null,{role:'member'}]){
    const route=load('app/api/sos/route.ts',{'next/server':reply,'@/lib/session':{getUserSession:async()=>user},'@/lib/user-roles':{isManagementUser:u=>u.role==='admin'},'@/lib/supabase/admin':{adminClient:{}},'@/lib/sos':{}});
    assert.equal((await route.GET({})).status,403);assert.equal((await route.POST({})).status,403);
  }
  const cron=load('app/api/cron/sos/route.ts',{'next/server':reply,'@/lib/sos':{dispatchDueSos:()=>{throw Error('must not run')}}});process.env.CRON_SECRET='mock';assert.equal((await cron.GET({headers:new Headers()})).status,401);
  const receipt=load('app/api/sos/receipt/route.ts',{'next/server':reply,'@/lib/supabase/admin':{adminClient:{}}});assert.equal((await receipt.POST({json:async()=>({token:'bad',stage:'displayed'})})).status,400);

  const handlers={};const reported=[];let displayed=0;let displayFailure=false;let options;
  vm.runInNewContext(fs.readFileSync('public/sw.js','utf8'),{self:{addEventListener:(n,f)=>handlers[n]=f,registration:{showNotification:async(_title,o)=>{options=o;displayed++;if(displayFailure)throw Error('blocked')}},location:{origin:'https://example.com'}},navigator:{},fetch:async(_url,o)=>{reported.push(JSON.parse(o.body).stage)},console,URL});
  async function event(){const promises=[];handlers.push({data:{json:()=>({title:'SOS',sosReceiptToken:'token',url:'/sos'})},waitUntil:p=>promises.push(p)});await Promise.all(promises)}
  await event();assert.equal(displayed,1);assert(reported.includes('received'));assert(reported.includes('displayed'));assert.equal(options.requireInteraction,true);
  reported.length=0;displayFailure=true;await event();assert(reported.includes('failed'));assert(!reported.includes('displayed'));
  console.log('SOS tests passed: push results, role/cron/receipt authorization, SW reception/display/failure.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
