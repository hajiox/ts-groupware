// Real BoardPage with a synthetic API in an isolated browser; no live account.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText
const helperModule = {exports:{}}
new Function('module','exports',compile(source('lib/board-attachment-refresh.ts')))(helperModule,helperModule.exports)
const {attachmentIdBatches,attachmentSignature,loadedAttachmentSignatures,mergeAttachmentSnapshots} = helperModule.exports
function unitTests() {
  const posts = Array.from({length:160},(_,i)=>({id:String(i),attachments:[{url:'old-'+i}],content:'preserved',order:i}))
  const comments = {one:Array.from({length:80},(_,i)=>({id:String(200+i),attachments:[{url:'old-comment'}]}))}
  const expected = loadedAttachmentSignatures(posts,comments)
  const chunks = attachmentIdBatches([...expected.keys(),'0'])
  assert.deepEqual(chunks.map(chunk=>chunk.length),[100,100,40])
  const incoming = new Map([['159',{id:'159',attachments:[{url:'new'}]}],['279',{id:'279',attachments:null}]])
  const merged = mergeAttachmentSnapshots(posts,incoming,expected)
  assert.equal(merged.length,160);assert.deepEqual(merged.map(p=>p.id),posts.map(p=>p.id))
  assert.equal(merged[0],posts[0]);assert.equal(merged[159].content,'preserved');assert.equal(merged[159].attachments[0].url,'new')
  assert.deepEqual(mergeAttachmentSnapshots(comments.one,incoming,expected).at(-1).attachments,[])
  assert.equal(mergeAttachmentSnapshots(posts,new Map(),expected),posts)
  const locallySaved = posts.map(p=>p.id==='159'?{...p,attachments:[{url:'local-save'}]}:p)
  assert.equal(mergeAttachmentSnapshots(locallySaved,incoming,expected),locallySaved)
  assert.equal(attachmentSignature(null),'[]')
}

function bundle() {
  const virtual = {
    entry:compile(`
      import React from 'react'; import {createRoot} from 'react-dom/client'; import BoardPage from 'board-page';
      const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
      const image=version=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><text x="1" y="30">'+version+'</text></svg>');
      window.__uuid=uuid;window.__image=image;
      const attachment=n=>({name:'fixture-'+n+'.png',type:'image/png',url:image('old-'+n),viewUrl:image('old-'+n)});
      const post=n=>({id:uuid(n),group_id:uuid(999),user_id:'user',parent_id:null,content:'fixture post '+n,attachments:[attachment(n)],created_at:new Date(Date.UTC(2026,9,1,0,n)).toISOString(),is_pinned:false,author:{id:'user',display_name:'Fixture user',picture_url:null},reactions:{},tasks:[],commentCount:n===150?80:0});
      window.__posts=Array.from({length:150},(_,i)=>post(150-i));
      window.__comments=Array.from({length:80},(_,i)=>({...post(501+i),parent_id:uuid(150),commentCount:0}));
      window.__posts[0].commentPreview=window.__comments.slice(-5);
      window.__requests=[];window.__aborted=0;window.__patches=0;window.__uploads=0;window.__alerts=[];
      window.alert=text=>window.__alerts.push(text);
      window.__changeAttachment=(n,version)=>{const row=[...window.__posts,...window.__comments].find(p=>p.id===uuid(n));row.attachments=[{...attachment(n),url:image(version),viewUrl:image(version)}];};
      window.fetch=async (url,options={})=>{
        const parsed=new URL(url,'https://fixture.invalid');
        if(parsed.pathname==='/api/auth/me')return {ok:true,json:async()=>({user:{id:'actor',role:'admin'}})};
        if(parsed.pathname==='/api/posts/attachment-snapshots'){
          const ids=parsed.searchParams.get('post_ids').split(',');window.__requests.push({ids,group:parsed.searchParams.get('group_id')});
          if(window.__loginRedirect){if(options.redirect==='error')throw new TypeError('Redirect blocked');return {ok:true,status:200,json:async()=>{throw new SyntaxError('Login HTML')}};}
          const rows=[...window.__posts,...window.__comments].filter(row=>ids.includes(row.id)).map(({id,attachments})=>({id,attachments:JSON.parse(JSON.stringify(attachments))}));
          if(window.__failChunk && ids.includes(uuid(1))){window.__failChunk=false;return {ok:false,status:500,json:async()=>({error:'fixture failure'})};}
          if(window.__authFailure)return {ok:false,status:403,json:async()=>({error:'fixture forbidden'})};
          if(window.__holdSnapshot){window.__holdSnapshot=false;return new Promise((resolve,reject)=>{window.__release=()=>resolve({ok:true,status:200,json:async()=>({posts:rows})});options.signal.addEventListener('abort',()=>{window.__aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true});});}
          return {ok:true,status:200,json:async()=>({posts:rows})};
        }
        if(parsed.pathname==='/api/posts'){
          if(options.method==='PATCH'){window.__patches++;const body=JSON.parse(options.body);const row=[...window.__posts,...window.__comments].find(row=>row.id===body.post_id);row.attachments=body.attachments;return {ok:true,json:async()=>({post:JSON.parse(JSON.stringify(row))})};}
          const parent=parsed.searchParams.get('parent_id');const before=parsed.searchParams.get('before');
          const all=parent?window.__comments:window.__posts.filter(row=>!before||row.created_at<before);
          return {ok:true,json:async()=>({posts:JSON.parse(JSON.stringify(all.slice(0,parent?100:50))),hasMore:!parent&&all.length>50,groupName:'Fixture Board',readReceipts:[]})};
        }
        return {ok:true,json:async()=>({settings:{},muted:false})};
      };
      const mounted=createRoot(document.getElementById('root'));window.__unmount=()=>mounted.unmount();
      mounted.render(<React.StrictMode><div className='app-shell'><main><BoardPage/></main></div></React.StrictMode>);
    `),
    'board-page':compile(source('app/board/[id]/page.tsx')),
    '@/lib/board-attachment-refresh':compile(source('lib/board-attachment-refresh.ts')),
    'next/navigation':`const React=require('react');exports.useRouter=()=>({push:()=>{}});exports.useParams=()=>({id:React.useSyncExternalStore(listener=>{window.addEventListener('fixture-group',listener);return()=>window.removeEventListener('fixture-group',listener);},()=>window.__group)});`,
    '@/components/image-annotation-editor':compile(`import React from 'react';export function ImageAnnotationEditor({imageUrl,onSave,onCancel}){const [draft,setDraft]=React.useState('');return <div role='dialog' aria-label='画像マーキング'><img src={imageUrl} alt='annotation-source'/><textarea aria-label='annotation-draft' value={draft} onChange={e=>setDraft(e.target.value)}/><button onClick={()=>onSave(new File(['fixture'],'marked.jpg',{type:'image/jpeg'}))}>fixture-save</button><button onClick={onCancel}>fixture-cancel</button></div>;}`),
    '@/components/link-preview':'exports.linkifyText=value=>value;exports.OgpPreviews=()=>null;',
    '@/components/read-receipt-avatars':'exports.ReadReceiptAvatars=()=>null;',
    '@/components/safe-line-avatar':'exports.SafeLineAvatar=()=>null;',
    '@/lib/clipboard-image':'exports.getClipboardImageFile=()=>null;',
    '@/lib/client-upload':`exports.uploadClientFile=async file=>{window.__uploads++;return {preparedFile:file,data:{url:window.__image('local-save'),viewUrl:window.__image('local-save'),name:'marked.jpg',type:'image/jpeg'}};};`,
    '@/lib/device-id':'exports.getDeviceHeaders=()=>({});',
    '@/lib/departments':'exports.USER_DEPARTMENTS=[];',
    '@/lib/mention-names':'exports.appendMentionIfMissing=value=>value;exports.formatMentionName=value=>value;exports.mentionDisplayName=user=>user.display_name;',
    '@/lib/reactions':'exports.REACTION_EMOJIS=[];',
    '@/lib/user-roles':"exports.getEffectiveUserRole=user=>user.role;exports.getUserRoleLabel=()=>'';exports.isManagementRole=role=>role==='admin';",
  }
  const modules=new Map()
  function add(id){if(modules.has(id))return;const code=virtual[id]??fs.readFileSync(id,'utf8');const dependencies={};modules.set(id,{code,dependencies});for(const match of code.matchAll(/require\(["']([^"']+)["']\)/g)){const name=match[1],resolved=Object.hasOwn(virtual,name)?name:require.resolve(name,{paths:[Object.hasOwn(virtual,id)?root:path.dirname(id)]});dependencies[name]=resolved;add(resolved)}}
  add('entry')
  return `(()=>{const process={env:{NODE_ENV:'development'}};const modules={${[...modules].map(([id,{code,dependencies}])=>`${JSON.stringify(id)}:[function(require,module,exports){${code}\n},${JSON.stringify(dependencies)}]`).join(',')}};const cache={};function load(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};const [factory,deps]=modules[id];factory(name=>load(deps[name]),module,module.exports);return module.exports;}load('entry');})();`
}
async function settle(page){await page.waitForTimeout(240)}
async function focus(page){await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))});await settle(page)}
async function waitForImage(page, selector, version){await page.waitForFunction(({selector,version})=>document.querySelector(selector)?.getAttribute('src')?.includes(version),{selector,version})}
const postSelector=n=>`#post-00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
async function mount(browser,viewport){
  const page=await browser.newPage({viewport}),errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort())
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
  await page.addStyleTag({content:source('app/globals.css')+'\nhtml,body,#root,.app-shell {height:100%;} .app-shell>main{height:100%;display:flex;min-height:0;width:100%;}'})
  await page.evaluate(()=>{
    window.__group='00000000-0000-4000-8000-0000000003e7';window.__visible='visible';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__visible});
    const originalSet=window.setInterval.bind(window),originalClear=window.clearInterval.bind(window),periodic=new Map();let next=-1;
    window.setInterval=(callback,ms,...args)=>{if(ms!==120000)return originalSet(callback,ms,...args);const id=next--;periodic.set(id,callback);return id};
    window.clearInterval=id=>{if(periodic.has(id))periodic.delete(id);else originalClear(id)};
    window.__poll=()=>{for(const callback of periodic.values())callback()};window.__periodicCount=()=>periodic.size;
    const originalTimeout=window.setTimeout.bind(window),originalClearTimeout=window.clearTimeout.bind(window),timeouts=new Map();let nextTimeout=-100;
    window.setTimeout=(callback,ms,...args)=>{if(ms!==20000)return originalTimeout(callback,ms,...args);const id=nextTimeout--;timeouts.set(id,callback);return id};
    window.clearTimeout=id=>{if(timeouts.has(id))timeouts.delete(id);else originalClearTimeout(id)};
    window.__expireRequest=()=>{for(const callback of [...timeouts.values()])callback()};window.__timeoutCount=()=>timeouts.size;
  })
  await page.addScriptTag({content:bundle()});await page.getByRole('heading',{name:'Fixture Board'}).waitFor();await settle(page)
  return {page,errors}
}
async function uiTests(){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright')
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined})
  try{
    for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
      const {page,errors}=await mount(browser,viewport)
      assert.ok(await page.evaluate(()=>window.__requests.length)>0,'Refresh once after initial loading')
      for(let i=0;i<2;i++){await page.getByRole('button',{name:'過去投稿を読み込む'}).click();await settle(page)}
      assert.equal(await page.locator('.post-list>.post-card').count(),150)
      await page.locator(postSelector(150)).getByRole('button',{name:'さらに75件のコメントを表示'}).click()
      assert.equal(await page.locator('.post-comment').count(),80)
      await page.getByRole('textbox',{name:'投稿テキスト',exact:true}).fill('preserved draft')
      await page.getByRole('searchbox',{name:'掲示板を検索'}).fill('fixture')
      await page.locator(postSelector(150)).getByRole('button',{name:'コメントする',exact:true}).click()
      await page.getByRole('textbox',{name:'コメントを入力',exact:true}).fill('preserved comment draft')
      await page.locator('.post-list').evaluate(element=>{element.scrollTop=700})
      await page.waitForTimeout(180)
      const scrollBefore=await page.locator('.post-list').evaluate(element=>element.scrollTop)
      await page.evaluate(()=>{window.__requests=[];window.__changeAttachment(1,'new-oldest');window.__changeAttachment(580,'new-old-comment');window.__failChunk=true})
      await focus(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),3,'All loaded roots and 80 expanded comments, max100 per chunk, focus/visibility debounced')
      assert.ok((await page.locator(postSelector(1)).locator('.post-card__image').getAttribute('src')).includes('old-1'))
      assert.ok((await page.locator('#comment-00000000-0000-4000-8000-000000000244').locator('.post-card__image').getAttribute('src')).includes('new-old-comment'))
      await focus(page)
      await waitForImage(page,postSelector(1)+' .post-card__image','new-oldest')
      assert.equal(await page.getByRole('textbox',{name:'投稿テキスト',exact:true}).inputValue(),'preserved draft')
      assert.equal(await page.getByRole('textbox',{name:'コメントを入力',exact:true}).inputValue(),'preserved comment draft')
      assert.equal(await page.getByRole('searchbox',{name:'掲示板を検索'}).inputValue(),'fixture')
      assert.equal(await page.locator('.post-comment').count(),80)
      assert.equal(await page.locator('.post-list>.post-card').count(),150)
      assert.ok(Math.abs(await page.locator('.post-list').evaluate(element=>element.scrollTop)-scrollBefore)<2)
      await page.locator(postSelector(1)).getByRole('button',{name:'fixture-1.pngを拡大表示',exact:true}).click()
      await page.evaluate(()=>window.__changeAttachment(1,'new-preview'));await focus(page)
      await waitForImage(page,'.image-preview-img','new-preview')
      await page.evaluate(()=>{window.__posts.find(row=>row.id===window.__uuid(1)).attachments=null});await focus(page)
      await page.locator('.image-preview-img').waitFor({state:'detached'})
      assert.equal(await page.locator('.image-preview-img').count(),0,'Removing the expanded attachment must close its stale preview')
      await page.evaluate(()=>window.__changeAttachment(1,'new-preview'));await focus(page)
      await page.locator(postSelector(1)).getByRole('button',{name:'fixture-1.pngを拡大表示',exact:true}).click()
      await page.evaluate(()=>{window.__posts.find(row=>row.id===window.__uuid(1)).attachments=[{type:'application/pdf',name:'fixture.pdf',url:'https://fixture.invalid/fixture.pdf'}]});await focus(page)
      await page.locator('.image-preview-img').waitFor({state:'detached'})
      assert.equal(await page.locator('.image-preview-img').count(),0,'Replacing the expanded image with a non-image must close its stale preview')
      await page.evaluate(()=>window.__changeAttachment(1,'new-preview'));await focus(page)
      await page.locator(postSelector(1)).getByRole('button',{name:'画像に赤丸・赤枠を追加'}).click()
      await page.getByRole('textbox',{name:'annotation-draft'}).fill('keep annotation')
      await page.evaluate(()=>window.__changeAttachment(1,'external-repair'));await focus(page)
      assert.equal(await page.getByRole('textbox',{name:'annotation-draft'}).inputValue(),'keep annotation')
      assert.ok((await page.getByAltText('annotation-source').getAttribute('src')).includes('new-preview'))
      await page.getByRole('button',{name:'fixture-save',exact:true}).click()
      assert.equal(await page.evaluate(()=>window.__uploads),0,'Observed remote replacement blocks saving an obsolete annotation before upload')
      assert.equal(await page.evaluate(()=>window.__alerts.length),1)
      await page.getByRole('button',{name:'fixture-cancel'}).click()
      await page.locator(postSelector(1)).getByRole('button',{name:'画像に赤丸・赤枠を追加'}).click()
      await page.evaluate(()=>{window.__holdSnapshot=true});await focus(page)
      const callsDuringHold=await page.evaluate(()=>window.__requests.length);await focus(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),callsDuringHold,'No overlapping refresh run')
      await page.getByRole('button',{name:'fixture-save',exact:true}).click()
      await page.getByRole('dialog',{name:'画像マーキング'}).waitFor({state:'detached'})
      await page.evaluate(()=>window.__release());await settle(page)
      assert.ok((await page.locator(postSelector(1)).locator('.post-card__image').getAttribute('src')).includes('local-save'),'An old in-flight snapshot cannot undo the local annotation save')
      await page.evaluate(()=>{window.__requests=[];window.__visible='hidden';document.dispatchEvent(new Event('visibilitychange'));window.__poll();window.dispatchEvent(new Event('focus'))});await settle(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),0,'Hidden pages do not poll or refresh on focus')
      await page.evaluate(()=>{window.__visible='visible';document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))});await settle(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),3)
      await page.evaluate(()=>{window.__authFailure=true;window.__requests=[]});await focus(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),1,'403 does not retry remaining chunks')
      assert.equal(await page.locator('.post-list>.post-card').count(),150)
      await page.evaluate(()=>{window.__authFailure=false;window.__loginRedirect=true;window.__requests=[]});await focus(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),1,'An expired session redirect stops the batch run without following the login page')
      assert.equal(await page.locator('.post-list>.post-card').count(),150)
      await page.evaluate(()=>{window.__loginRedirect=false})
      await page.evaluate(()=>{window.__authFailure=false;window.__holdSnapshot=true});await focus(page)
      const beforeTimeout=await page.evaluate(()=>window.__aborted)
      await page.evaluate(()=>window.__expireRequest());await settle(page)
      assert.ok(await page.evaluate(()=>window.__aborted)>beforeTimeout,'A hung batch is aborted at the bounded timeout')
      const beforeRecovery=await page.evaluate(()=>window.__requests.length);await focus(page)
      assert.equal(await page.evaluate(()=>window.__requests.length),beforeRecovery+3,'A timed-out run releases its lock for the next normal refresh')
      await page.evaluate(()=>{window.__authFailure=false;window.__holdSnapshot=true});await focus(page)
      await page.evaluate(()=>{window.__group='00000000-0000-4000-8000-0000000003e8';window.dispatchEvent(new Event('fixture-group'))});await settle(page)
      assert.ok(await page.evaluate(()=>window.__aborted)>0,'Changing group aborts the old request')
      await page.evaluate(()=>{window.__holdSnapshot=true});await focus(page)
      const abortedBefore=await page.evaluate(()=>window.__aborted)
      await page.evaluate(()=>window.__unmount());await settle(page)
      assert.ok(await page.evaluate(()=>window.__aborted)>abortedBefore)
      assert.equal(await page.evaluate(()=>window.__periodicCount()),0)
      assert.equal(await page.evaluate(()=>window.__timeoutCount()),0)
      assert.deepEqual(errors,[])
      await page.close()
    }
    console.log('Board attachment refresh: pure merge plus real mobile/desktop Board wiring, 150 roots/80 comments, drafts/search/scroll, partial failure, preview/annotation, local-save race, debounce/hidden/auth/abort passed')
  }finally{await browser.close()}
}
unitTests()
console.log('Board attachment merge: loaded IDs/chunk bounds, order/fields/identity, missing rows, null attachments and concurrent local-save protection passed')
if(process.argv.includes('--ui'))uiTests().catch(error=>{console.error(error);process.exitCode=1})
