const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

// An isolated browser fixture: real AppShell/CodexMtgStatus and application CSS,
// with synthetic messages/status data. No application server, account, or API.
const root = path.resolve(__dirname, "..");
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function bundleFixture(baseline = false) {
  const virtual = {
    "fixture-entry": compile(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AppShell } from 'fixture-shell';
      import { CodexMtgStatus } from 'fixture-status';
      import { usePathname } from 'next/navigation';
      const navigate = (pathname) => {
        window.__fixturePathname = pathname;
        window.dispatchEvent(new Event('fixture-route'));
      };
      window.__fixtureNavigate = navigate;
      window.__fixtureSetSos = (value) => {
        window.__fixtureSos = value;
        window.dispatchEvent(new Event('fixture-route'));
      };
      function Fixture() {
        const pathname = usePathname();
        const sos = React.useSyncExternalStore(
          listener => { window.addEventListener('fixture-route', listener); return () => window.removeEventListener('fixture-route', listener); },
          () => window.__fixtureSos,
        );
        return <AppShell>
          <main style={{ flex: 1 }}>
            <div className="app-shell__alerts">{sos && <section aria-label="SOS状況" style={{ margin: '12px auto', maxWidth: 850, padding: 16 }}>
              {[0, 1, 2].map(i => <article key={i} style={{ background: '#7f1d1d', border: '2px solid #ef4444', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                <strong>SOS 未対応 — テスト端末</strong><p>管理者の確認待ち</p><button>対応します（再通知停止）</button>
              </article>)}
            </section>}</div>
            {pathname.startsWith('/chat/') ? <div className="chat-page">
              <header className="top-header" role="banner">
                <button type="button" className="top-header__back" onClick={() => navigate('/groups')} aria-label="グループ一覧に戻る">‹</button>
                <h1 className="top-header__title">💬 CodexMTG</h1>
                <button className="notif-toggle-btn" aria-label="通知をOFFにする">🔔</button>
              </header>
              <div className="chat-tools">
                <CodexMtgStatus canManageMachines={true} />
                <div className="thread-search thread-search--chat" role="search"><input type="search" placeholder="Chatを検索" aria-label="Chatを検索" /></div>
              </div>
              <section className="chat-messages" role="log" aria-label="チャットメッセージ">
                {Array.from({ length: 50 }, (_, i) => <div key={i} className="msg msg--other"><div className="msg__body"><span className="msg__name">テスト PC</span><p className="msg__bubble">合成メッセージ {i}：ホームへ戻る操作とスクロール領域の検証用です。</p></div></div>)}
              </section>
              <footer className="chat-footer"><form className="chat-input-bar" onSubmit={e => e.preventDefault()}>
                <button type="button" className="mention-toggle-btn">@</button><button type="button" className="icon-btn">📎</button>
                <textarea aria-label="メッセージ" rows={1} /><button type="button" className="send-btn">↑</button>
              </form></footer>
            </div> : <div className="groups-page" style={{ minHeight: 1200 }}><h1>ホーム</h1></div>}
          </main>
          <nav className="bottom-nav" aria-label="メインナビゲーション">
            {['ホーム', 'タスク', 'DM', '管理', '設定'].map((label, i) => <a key={label} href={['/groups', '/tasks', '/members', '/admin', '/settings'][i]} className="bottom-nav__item" onClick={event => { event.preventDefault(); navigate(event.currentTarget.getAttribute('href')); }}>
              <span className="bottom-nav__icon" aria-hidden="true">{['🏠', '✓', '💬', '🛡', '⚙'][i]}</span><span>{label}</span>
            </a>)}
          </nav>
        </AppShell>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `),
    "fixture-shell": baseline
      ? compile("export function AppShell({children}) { return <div className='app-shell'>{children}</div>; }")
      : compile(source("components/app-shell.tsx")),
    "fixture-status": compile(source("components/codex-mtg-status.tsx")),
    "next/navigation": `const React = require('react'); exports.usePathname = () => React.useSyncExternalStore(
      listener => { window.addEventListener('fixture-route', listener); return () => window.removeEventListener('fixture-route', listener); },
      () => window.__fixturePathname);`,
    "@/lib/device-id": "exports.getDeviceHeaders = () => ({});",
  };
  const modules = new Map();
  function add(id) {
    if (modules.has(id)) return;
    const code = virtual[id] ?? fs.readFileSync(id, "utf8");
    const dependencies = {};
    modules.set(id, { code, dependencies });
    for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = match[1];
      const dependency = Object.hasOwn(virtual, name) ? name : require.resolve(name, { paths: [Object.hasOwn(virtual, id) ? root : path.dirname(id)] });
      dependencies[name] = dependency;
      add(dependency);
    }
  }
  add("fixture-entry");
  return `(() => {
    const process = { env: { NODE_ENV: 'production' } };
    const modules = {${[...modules].map(([id, module]) => `${JSON.stringify(id)}: [function(require, module, exports) {\n${module.code}\n}, ${JSON.stringify(module.dependencies)}]`).join(",\n")}};
    const cache = {};
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = { exports: {} };
      const [factory, dependencies] = modules[id];
      factory(name => load(dependencies[name]), module, module.exports);
      return module.exports;
    }
    load('fixture-entry');
  })();`;
}

async function mount(context, viewport, { baseline = false, safeArea = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.setViewportSize(viewport);
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="root"></div></body></html>');
  // The old shell omits the chat-scoped class, so it also provides a permanent
  // negative control with current CSS. An explicit ref can compare old CSS too.
  const css = baseline && process.env.CHAT_NAV_BASELINE_REF
    ? execFileSync("git", ["show", `${process.env.CHAT_NAV_BASELINE_REF}:app/globals.css`], { cwd: root, encoding: "utf8", maxBuffer: 5_000_000 })
    : source("app/globals.css");
  await page.addStyleTag({ content: css });
  if (safeArea) await page.addStyleTag({ content: ":root { --safe-top: 47px; --safe-bottom: 34px; }" });
  await page.evaluate(({ height }) => {
    window.__fixturePathname = "/chat/codex-mtg";
    window.__fixtureSos = false;
    const listeners = { resize: new Set(), scroll: new Set() };
    class TestViewport extends EventTarget {
      height = height;
      offsetTop = 0;
      addEventListener(type, listener, options) { listeners[type]?.add(listener); super.addEventListener(type, listener, options); }
      removeEventListener(type, listener, options) { listeners[type]?.delete(listener); super.removeEventListener(type, listener, options); }
    }
    const viewport = new TestViewport();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    window.__viewportListenerCounts = () => ({ resize: listeners.resize.size, scroll: listeners.scroll.size });
    window.__setVisualViewport = (height, offsetTop = 0, event = "resize") => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event(event));
    };
    window.fetch = async () => ({ ok: true, json: async () => ({
      ok: true,
      status: { ownerPcName: "TSA", online: true, pendingCount: 0, runningCount: 0, needsOperatorCount: 6, lastSeenAt: "2026-10-10T00:00:00Z" },
      machines: Array.from({ length: 12 }, (_, i) => ({ id: String(i), pcName: `TEST_PC_${i}`, canExecuteCode: i === 0, lastSeenAt: "2026-10-10T00:00:00Z", revokedAt: null, expiresAt: "2027-01-01T00:00:00Z" })),
      jobs: Array.from({ length: 5 }, (_, i) => ({ id: String(i), status: "needs_operator", createdAt: "2026-10-10T00:00:00Z", postId: String(i), summary: "連携状況の表示に使う合成データです。".repeat(30) })),
    }) });
  }, viewport);
  await page.addScriptTag({ content: bundleFixture(baseline) });
  await page.getByRole("button", { name: "グループ一覧に戻る", exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "待機中" }).waitFor();
  return { page, errors };
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function geometry(page) {
  return page.evaluate(() => {
    const viewport = window.visualViewport;
    function rect(selector) {
      const element = document.querySelector(selector);
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height, hit: element === hit || element.contains(hit) };
    }
    return {
      viewport: { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height },
      back: rect(".top-header__back"), home: rect(".bottom-nav__item"),
      shell: rect(".app-shell"), nav: rect(".bottom-nav"), footer: rect(".chat-footer"), textarea: rect('textarea[aria-label="メッセージ"]'),
      messages: rect(".chat-messages"), status: rect(".codex-mtg-status"),
      documentWidth: document.documentElement.scrollWidth, windowWidth: window.innerWidth,
      documentTop: window.scrollY,
    };
  });
}

async function assertNavigationVisible(page, label) {
  const state = await geometry(page);
  for (const name of ["home", "back"]) {
    assert.ok(state[name].top >= state.viewport.top - 1, `${label}: ${name} must remain below the visible top ${JSON.stringify(state)}`);
    assert.ok(state[name].bottom <= state.viewport.bottom + 1, `${label}: ${name} must remain above the visible bottom ${JSON.stringify(state)}`);
    assert.ok(state[name].hit, `${label}: ${name} must receive taps without an overlay`);
    assert.ok(state[name].left >= 0 && state[name].right <= state.windowWidth + 1, `${label}: ${name} must remain horizontally visible`);
  }
  assert.ok(state.footer.bottom <= state.nav.top + 1, `${label}: composer must fit above navigation ${JSON.stringify(state)}`);
  assert.ok(state.footer.top >= state.back.bottom - 1, `${label}: composer must remain below the back control`);
  assert.ok(state.documentWidth <= state.windowWidth + 1, `${label}: no horizontal page overflow`);
  return state;
}

function assertComposerContentVisible(state, label) {
  assert.ok(state.textarea.top >= state.footer.top - 1 && state.textarea.bottom <= state.footer.bottom + 1, `${label}: message input must fit within its composer`);
  assert.ok(state.textarea.hit, `${label}: message input must receive taps`);
}

async function expandStatus(page) {
  await page.locator(".codex-mtg-status > details > summary").click();
  // Open nested content too, stressing the real component's maximum content.
  await page.locator(".codex-mtg-status details").evaluateAll(elements => elements.forEach(element => { element.open = true; }));
  await settle(page);
}

async function assertReturnHome(page, control, label) {
  await page.getByRole(control === "back" ? "button" : "link", { name: control === "back" ? "グループ一覧に戻る" : "ホーム", exact: true }).click();
  await page.waitForFunction(() => window.__fixturePathname === "/groups" && !document.querySelector(".app-shell--chat"));
  const cleanup = await page.evaluate(() => ({
    listeners: window.__viewportListenerCounts(),
    height: document.querySelector(".app-shell").style.getPropertyValue("--chat-viewport-height"),
    top: document.querySelector(".app-shell").style.getPropertyValue("--chat-viewport-top"),
    position: getComputedStyle(document.querySelector(".app-shell")).position,
    overflowY: getComputedStyle(document.body).overflowY,
  }));
  assert.deepEqual(cleanup.listeners, { resize: 0, scroll: 0 }, `${label}: viewport listeners released on navigation`);
  assert.equal(cleanup.height, "", `${label}: viewport height released on navigation`);
  assert.equal(cleanup.top, "", `${label}: viewport offset released on navigation`);
  assert.notEqual(cleanup.position, "fixed", `${label}: home must not retain the fixed chat shell`);
  assert.notEqual(cleanup.overflowY, "hidden", `${label}: home scrolling restored`);
}

async function main() {
  const browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  let passed = 0;
  try {
    const cases = [
      { label: "portrait", width: 390, height: 844, safeArea: true, control: "home" },
      { label: "short portrait with expanded status", width: 390, height: 360, details: true, control: "back" },
      { label: "landscape with expanded status and SOS", width: 844, height: 390, details: true, sos: true, control: "home" },
      { label: "keyboard offset with expanded status and SOS", width: 390, height: 844, details: true, sos: true, keyboard: true, control: "back" },
      { label: "keyboard with safe area and SOS", width: 390, height: 844, safeArea: true, details: true, sos: true, keyboard: true, control: "home" },
      { label: "keyboard restoration", width: 390, height: 844, safeArea: true, details: true, keyboard: true, restore: true, control: "home" },
      { label: "desktop centered navigation", width: 1280, height: 900, desktop: true, details: true, control: "home" },
    ];
    for (const scenario of cases) {
      const { page, errors } = await mount(scenario.desktop ? desktopContext : context, { width: scenario.width, height: scenario.height }, scenario);
      if (scenario.details) await expandStatus(page);
      if (scenario.sos) await page.evaluate(() => window.__fixtureSetSos(true));
      if (scenario.keyboard) {
        await page.getByRole("textbox", { name: "メッセージ", exact: true }).focus();
        await page.evaluate(() => { window.__setVisualViewport(340, 40); window.__setVisualViewport(320, 87, "scroll"); });
      }
      await settle(page);
      const visible = await assertNavigationVisible(page, scenario.label);
      if (!scenario.keyboard) assertComposerContentVisible(visible, scenario.label);
      if (scenario.desktop) {
        assert.ok(Math.abs(visible.nav.left + visible.nav.width / 2 - visible.windowWidth / 2) < 1, "desktop navigation must remain centered");
        assert.ok(visible.nav.width <= 576, "desktop navigation retains the bounded width");
      }
      if (scenario.restore) {
        await page.evaluate(() => { window.__setVisualViewport(844, 0); window.dispatchEvent(new Event("pageshow")); });
        await settle(page);
        const restored = await assertNavigationVisible(page, `${scenario.label} after close`);
        assertComposerContentVisible(restored, `${scenario.label} after close`);
        assert.ok(Math.abs(restored.shell.height - 844) < 1, "restored shell fills the visible screen");
        if (process.env.CHAT_NAV_SCREENSHOT_PATH) {
          const screenshotPath = path.resolve(process.env.CHAT_NAV_SCREENSHOT_PATH);
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          await page.screenshot({ path: screenshotPath });
        }
      }
      await assertReturnHome(page, scenario.control, scenario.label);
      assert.deepEqual(errors, [], `${scenario.label}: browser must not report runtime errors`);
      await page.close();
      passed++;
    }

    const baseline = await mount(context, { width: 390, height: 844 }, { baseline: true });
    await baseline.page.evaluate(() => window.__setVisualViewport(320, 87));
    await settle(baseline.page);
    const before = await geometry(baseline.page);
    assert.ok(before.home.bottom > before.viewport.bottom + 100, "negative control: old fixed navigation falls below the keyboard's visible viewport");
    assert.deepEqual(baseline.errors, []);
    await baseline.page.close();
    console.log(`PASS ${passed} responsive navigation scenarios (real components/CSS); old layout negative control detected.`);
  } finally {
    await context.close();
    await desktopContext.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
