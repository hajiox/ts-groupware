// Real ChatPage, synthetic API and a fresh headless browser; no account or writes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText
const source = file => fs.readFileSync(path.join(root, file), 'utf8')

function bundle() {
  const virtual = {
    entry: compile(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatPage from 'chat-page';
      import { encodeChatCursor, decodeChatCursor, compareChatMessages } from '@/lib/chat-pagination';
      const makeMessage = (n, time = '2026-10-01T00:00:00.123456+00:00') => ({
        id: '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0'),
        user_id: 'user', content: n === 1 ? 'historical-marker' : 'Synthetic message ' + n + ' — history and scroll position verification',
        attachments: [], created_at: time, author: { id: 'user', display_name: 'Synthetic user', picture_url: null },
        isOwn: false, reactions: {},
      });
      window.__messages = window.__emptyChat ? [] : Array.from({length: 150}, (_, i) => makeMessage(i + 1));
      window.__addIncoming = () => window.__messages.push(...Array.from({length:205}, (_, i) => makeMessage(2000 + i, '2026-10-02T00:00:00.000001+00:00')));
      window.__addOne = () => window.__messages.push(makeMessage(2000, '2026-10-02T00:00:00.000001+00:00'));
      window.fetch = async (url, options = {}) => {
        const parsed = new URL(url, 'https://fixture.invalid');
        if (parsed.pathname === '/api/reactions') return {ok: false, status: 500, json: async () => ({error:'Synthetic reaction error'})};
        if (parsed.pathname !== '/api/chat') return {ok:true,json:async()=>({muted:false})};
        if (options.method === 'POST') {
          const sent = {...makeMessage(3000, '2026-10-03T00:00:00+00:00'), isOwn:true, content:JSON.parse(options.body).content};
          window.__messages.push(sent);
          return {ok:true,json:async()=>({message:sent})};
        }
        const before = parsed.searchParams.get('before');
        const after = parsed.searchParams.get('after');
        if (before && window.__failHistory) {window.__failHistory = false; return {ok:false,status:500,json:async()=>({error:'Synthetic history error'})};}
        const cursor = before || after ? decodeChatCursor(before || after) : null;
        let rows = [...window.__messages].filter(message => !cursor || (before ? compareChatMessages(message,cursor)<0 : compareChatMessages(message,cursor)>0));
        rows.sort((a,b)=>compareChatMessages(a,b)*(after?1:-1));
        const hasMore = rows.length > 80;
        rows = rows.slice(0,80);
        if (!after) rows.reverse();
        const oldestCursor = rows.length ? encodeChatCursor(rows[0]) : null;
        const newestCursor = rows.length ? encodeChatCursor(rows[rows.length-1]) : null;
        return {ok:true,json:async()=>({group:{id:'fixture',name:'Synthetic Chat'},members:[],currentUser:{id:'actor',role:'staff'},messages:rows,readReceipts:[],
          pagination:{hasMore,oldestCursor,newestCursor,nextCursor:hasMore?(after?newestCursor:oldestCursor):null}})};
      };
      createRoot(document.getElementById('root')).render(<React.StrictMode><div className='app-shell app-shell--chat'><main><ChatPage /></main></div></React.StrictMode>);
    `),
    'chat-page': compile(source('app/chat/[id]/page.tsx')),
    '@/lib/chat-pagination': compile(source('lib/chat-pagination.ts')),
    'next/navigation': "exports.useParams=()=>({id:'fixture'}); exports.useRouter=()=>({push:()=>{}});",
    '@/components/image-annotation-editor': 'exports.ImageAnnotationEditor=()=>null;',
    '@/components/link-preview': 'exports.linkifyText=text=>text;',
    '@/components/read-receipt-avatars': 'exports.ReadReceiptAvatars=()=>null;',
    '@/components/safe-line-avatar': 'exports.SafeLineAvatar=()=>null;',
    '@/components/codex-mtg-status': 'exports.CodexMtgStatus=()=>null;',
    '@/lib/codex-mtg-policy': 'exports.isCodexMtgGroup=()=>false;',
    '@/lib/clipboard-image': 'exports.getClipboardImageFile=()=>null;',
    '@/lib/client-upload': '',
    '@/lib/device-id': 'exports.getDeviceHeaders=()=>({});',
    '@/lib/departments': 'exports.USER_DEPARTMENTS=[];',
    '@/lib/mention-names': 'exports.formatMentionName=value=>value; exports.mentionDisplayName=user=>user.display_name;',
    '@/lib/reactions': 'exports.REACTION_EMOJIS=["👍"];',
    '@/lib/user-roles': 'exports.isManagementRole=()=>false; exports.getEffectiveUserRole=user=>user.role; exports.getUserRoleLabel=()=>"";',
  }
  const modules = new Map()
  function add(id) {
    if (modules.has(id)) return
    const code = virtual[id] ?? fs.readFileSync(id, 'utf8')
    const dependencies = {}
    modules.set(id, { code, dependencies })
    for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = match[1]
      const resolved = Object.hasOwn(virtual, name) ? name : require.resolve(name, { paths: [Object.hasOwn(virtual, id) ? root : path.dirname(id)] })
      dependencies[name] = resolved
      add(resolved)
    }
  }
  add('entry')
  return `(()=>{const process={env:{NODE_ENV:'development'}};const modules={${[...modules].map(([id, {code, dependencies}]) => `${JSON.stringify(id)}:[function(require,module,exports){${code}\n},${JSON.stringify(dependencies)}]`).join(',')}};const cache={};function load(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};const [factory,deps]=modules[id];factory(name=>load(deps[name]),module,module.exports);return module.exports;}load('entry');})();`
}

async function mount(browser, viewport, empty = false) {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.abort())
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>')
  await page.addStyleTag({ content: source('app/globals.css') + '\nhtml,body,#root,.app-shell {height:100%;} .app-shell>main {height:100%;display:flex;min-height:0;} .chat-page {height:100%;}' })
  await page.evaluate(empty => {
    window.__emptyChat = empty
    const polls = new Map()
    const originalSet = window.setInterval.bind(window)
    const originalClear = window.clearInterval.bind(window)
    let next = -1
    window.setInterval = (callback, ms, ...args) => {
      if (ms !== 4000) return originalSet(callback, ms, ...args)
      const id = next--
      polls.set(id, callback)
      return id
    }
    window.clearInterval = id => { if (polls.has(id)) polls.delete(id); else originalClear(id) }
    window.__runPoll = () => { for (const callback of polls.values()) callback() }
  }, empty)
  await page.addScriptTag({ content: bundle() })
  await page.getByRole('heading', { name: 'Synthetic Chat' }).waitFor()
  if (empty) await page.getByText('メッセージはまだありません。最初のメッセージを送りましょう。').waitFor()
  else await page.waitForFunction(() => document.querySelectorAll('[data-message-id]').length === 80)
  return { page, errors }
}

async function visibleAnchor(page, id) {
  return page.evaluate(id => {
    const container = document.querySelector('.chat-messages')
    const element = document.querySelector(`[data-message-id="${id}"]`)
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top
  }, id)
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
  try {
    for (const viewport of [{width:390,height:844}, {width:1280,height:900}]) {
      const {page,errors} = await mount(browser, viewport)
      await page.locator('.chat-messages').evaluate(element => {element.scrollTop=0})
      const anchor = await page.locator('[data-message-id]').first().getAttribute('data-message-id')
      const before = await visibleAnchor(page, anchor)
      await page.evaluate(()=>{window.__failHistory=true})
      await page.getByRole('button',{name:'以前のメッセージを読み込む'}).click()
      await page.getByRole('alert').filter({hasText:'Synthetic history error'}).waitFor()
      assert.equal(await page.locator('[data-message-id]').count(),80)
      await page.getByRole('button',{name:'以前のメッセージを読み込む'}).click()
      await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===150)
      assert.ok(Math.abs(await visibleAnchor(page,anchor)-before)<2, 'Loading history must retain the visible message position')
      assert.equal(await page.getByRole('button',{name:'以前のメッセージを読み込む'}).count(),0)
      await page.getByRole('searchbox',{name:'Chatを検索'}).fill('historical-marker')
      assert.equal(await page.locator('[data-message-id]').count(),1)
      await page.getByRole('searchbox',{name:'Chatを検索'}).fill('')
      await page.locator('.chat-messages').evaluate(element=>{element.scrollTop=0})
      await page.locator('[data-message-id]').first().getByRole('button',{name:'👍 0件'}).click()
      await page.waitForFunction(()=>document.querySelector('[data-message-id] .reaction-btn').textContent.trim()==='👍')
      assert.equal(await page.locator('[data-message-id]').count(),150, 'Reaction errors must not discard historical pages')
      await page.evaluate(()=>window.__addIncoming())
      await page.getByRole('textbox',{name:'メッセージ',exact:true}).fill('Synthetic locally sent post')
      await page.getByRole('button',{name:'送信',exact:true}).click()
      await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===151)
      await page.evaluate(()=>window.__runPoll())
      await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===356)
      const ids = await page.locator('[data-message-id]').evaluateAll(elements=>elements.map(element=>element.dataset.messageId))
      assert.equal(new Set(ids).size,356,'Polling must merge without duplicates or skipped intervening posts')
      assert.deepEqual(ids,[...ids].sort(),'Timestamp ties must retain the server ID ordering')
      assert.deepEqual(errors,[])
      await page.close()
    }
    const {page,errors} = await mount(browser,{width:390,height:844},true)
    await page.evaluate(()=>{window.__addOne();window.__runPoll()})
    await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===1)
    assert.deepEqual(errors,[])
    await page.close()
    console.log('Chat history UI: mobile/desktop history, retry, scroll preservation, old-message search, reaction rollback, 205-post catch-up with local send, empty-chat polling passed')
  } finally { await browser.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
