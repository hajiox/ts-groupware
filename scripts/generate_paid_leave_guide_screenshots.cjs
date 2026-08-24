const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "public", "manual", "screenshots");

const baseCss = `
  :root {
    color-scheme: dark;
    font-family: "Yu Gothic UI", "Meiryo", sans-serif;
    background: #0b1426;
    color: #f8fafc;
  }
  * { box-sizing: border-box; }
  body { width: 390px; min-height: 844px; margin: 0; background: #0b1426; }
  button { font: inherit; }
  .phone {
    min-height: 844px;
    background: #0b1426;
    overflow: hidden;
  }
  .header {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: center;
    min-height: 64px;
    border-bottom: 1px solid #324158;
    background: #1b2a3e;
    padding: 0 8px;
  }
  .header h1 { margin: 0; font-size: 18px; text-align: center; letter-spacing: 0; }
  .header small { display: block; margin-top: 2px; color: #94a3b8; font-size: 10px; text-align: center; }
  .back, .refresh {
    border: 0;
    background: transparent;
    color: #60a5fa;
    font-size: 28px;
  }
  .content { padding: 14px 12px 90px; }
  .eyebrow { color: #60a5fa; font-size: 10px; font-weight: 800; }
  .card {
    border: 1px solid #334155;
    border-radius: 8px;
    background: #1e2d42;
    padding: 13px;
  }
  .bottom-nav {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    height: 72px;
    border-top: 1px solid #334155;
    background: #1b2a3e;
  }
  .bottom-nav div {
    display: grid;
    place-content: center;
    gap: 4px;
    color: #64748b;
    font-size: 10px;
    text-align: center;
  }
  .bottom-nav b { font-size: 21px; font-weight: 400; }
  .bottom-nav .active { color: #60a5fa; }
  .step {
    display: inline-grid;
    place-items: center;
    width: 25px;
    height: 25px;
    border-radius: 50%;
    background: #f59e0b;
    color: #111827;
    font-size: 13px;
    font-weight: 900;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, .22);
  }
`;

function frame(content, navActive = "home") {
  const navItems = [
    ["home", "⌂", "ホーム"],
    ["tasks", "✓", "タスク"],
    ["dm", "●", "DM"],
    ["admin", "◆", "管理"],
    ["settings", "⚙", "設定"],
  ];
  const nav = navItems
    .map(([key, icon, label]) => `<div class="${key === navActive ? "active" : ""}"><b>${icon}</b><span>${label}</span></div>`)
    .join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${baseCss}</style></head>
    <body><main class="phone">${content}<nav class="bottom-nav">${nav}</nav></main></body></html>`;
}

function homeHtml() {
  return frame(`
    <header class="header">
      <button class="back">‹</button>
      <div><h1>TSG</h1><small>ホーム</small></div>
      <button class="refresh">↻</button>
    </header>
    <div class="content">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <div style="display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#1d4ed8;font-weight:900">TSG</div>
        <div><strong style="font-size:16px">お知らせ</strong><small style="display:block;color:#94a3b8">自分に必要な情報を確認</small></div>
      </div>
      <a class="card" style="position:relative;display:block;border-color:#2563eb;background:#142b52;color:#fff;text-decoration:none;box-shadow:inset 4px 0 0 #3b82f6">
        <span class="step" style="position:absolute;right:10px;top:10px">1</span>
        <span class="eyebrow">シフト希望回収</span>
        <strong style="display:block;margin-top:5px;font-size:17px">フロア 8月1日〜8月15日</strong>
        <small style="display:block;margin-top:8px;color:#cbd5e1">提出期限 7月29日</small>
        <em style="display:inline-block;margin-top:10px;border-radius:5px;background:#b91c1c;padding:5px 9px;color:#fff;font-size:11px;font-style:normal;font-weight:800">未提出</em>
      </a>
      <section style="margin-top:14px">
        <article class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <div style="display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:#173b70">⌂</div>
          <div><strong>NEWブランド館（フロア）</strong><small style="display:block;margin-top:4px;color:#94a3b8">掲示板の新着情報</small></div>
        </article>
        <article class="card" style="display:flex;align-items:center;gap:12px">
          <div style="display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:#174c3a">●</div>
          <div><strong>グループChat</strong><small style="display:block;margin-top:4px;color:#94a3b8">新しいメッセージ</small></div>
        </article>
      </section>
    </div>
  `);
}

function requestHtml() {
  const days = Array.from({ length: 15 }, (_, index) => index + 1);
  const blanks = Array.from({ length: 6 }, () => `<span></span>`).join("");
  const dayCells = days.map((day) => {
    const selected = day === 7;
    return `<button class="day ${selected ? "selected" : ""}">${day}${selected ? "<small>有給</small>" : ""}</button>`;
  }).join("");

  return frame(`
    <style>
      .request-head { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px; }
      .request-head h2 { margin:3px 0 0;font-size:18px; }
      .status { color:#86efac;font-size:11px;font-weight:800; }
      .mode { display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:11px;border:1px solid #334155;border-radius:8px;background:#111c2e;padding:5px; }
      .mode button { min-height:42px;border:1px solid transparent;border-radius:6px;background:transparent;color:#94a3b8;font-size:11px;font-weight:800; }
      .mode .active { border-color:#22c55e;background:rgba(20,83,45,.72);color:#dcfce7; }
      .calendar { display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-top:12px; }
      .weekday { color:#94a3b8;font-size:11px;font-weight:800;text-align:center; }
      .day { position:relative;display:grid;place-items:center;min-height:42px;border:1px solid #334155;border-radius:7px;background:#111c2e;color:#f8fafc;font-size:14px;font-weight:900; }
      .day.selected { border-color:#22c55e;background:rgba(20,83,45,.84);color:#dcfce7; }
      .day small { position:absolute;right:3px;bottom:3px;font-size:8px; }
      .save { width:100%;min-height:46px;margin-top:13px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-size:15px;font-weight:900; }
    </style>
    <header class="header">
      <button class="back">‹</button>
      <div><h1>シフト</h1><small>フロア</small></div>
      <button class="refresh">↻</button>
    </header>
    <div class="content">
      <section class="card">
        <div class="request-head">
          <div><span class="eyebrow">8月前半</span><h2>休み・有給希望</h2></div>
          <span class="status">締切 7月29日</span>
        </div>
        <div class="mode">
          <button>休み希望</button>
          <button class="active"><span class="step" style="width:21px;height:21px;margin-right:3px;font-size:11px">2</span>有給（全休）</button>
          <button>有給（半休）</button>
        </div>
        <div class="calendar">
          ${["日","月","火","水","木","金","土"].map((d) => `<span class="weekday">${d}</span>`).join("")}
          ${blanks}${dayCells}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;color:#cbd5e1;font-size:11px">
          <span class="step">3</span><span>有給を取りたい日を押します</span>
        </div>
        <button class="save"><span class="step" style="margin-right:8px;background:#fff;color:#1d4ed8">4</span>保存して提出</button>
      </section>
      <p style="margin:10px 2px;color:#94a3b8;font-size:11px;line-height:1.6">締切前・シフト確定前なら、同じ画面から変更できます。</p>
    </div>
  `, "home");
}

function balanceHtml() {
  return frame(`
    <style>
      .overview { display:grid;grid-template-columns:repeat(2,1fr);gap:9px; }
      .overview .balance { grid-column:1/-1;background:#103533;border-color:#17755f; }
      .metric { min-height:104px; }
      .metric span { display:block;color:#94a3b8;font-size:10px;font-weight:800; }
      .metric strong { display:block;margin-top:12px;font-size:23px;letter-spacing:0; }
      .metric small { display:block;margin-top:4px;color:#94a3b8;font-size:10px; }
      .balance strong { color:#4ade80;font-size:36px; }
      .list { margin-top:11px; }
      .list h2 { margin:3px 0 10px;font-size:16px; }
      .lot { display:flex;justify-content:space-between;align-items:center;border-top:1px solid #334155;padding:11px 0; }
      .lot strong,.lot small { display:block; }
      .lot small { margin-top:3px;color:#94a3b8;font-size:9px; }
      .lot em { color:#86efac;font-size:13px;font-style:normal;font-weight:900; }
    </style>
    <header class="header">
      <button class="back">‹</button>
      <div><h1>有給・欠勤</h1><small>自分の勤務情報</small></div>
      <button class="refresh">↻</button>
    </header>
    <div class="content">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span class="step">5</span><strong>自分の残日数を確認</strong>
      </div>
      <section class="overview">
        <article class="card metric balance"><span>有給残日数</span><strong>15<small style="display:inline;color:#86efac;font-size:14px">日</small></strong><small>今日使える残日数</small></article>
        <article class="card metric"><span>次回法定付与</span><strong style="font-size:17px">2027-05-21</strong><small>15日見込</small></article>
        <article class="card metric"><span>現在の出勤率</span><strong style="font-size:21px">80.0%</strong><small>4/5日</small></article>
      </section>
      <section class="card list">
        <span class="eyebrow">付与ロット</span>
        <h2>有効な有給</h2>
        <div class="lot"><div><strong>2026-08-01</strong><small>2028-08-01まで</small></div><em>15 / 15日</em></div>
      </section>
      <p style="margin:10px 2px;color:#94a3b8;font-size:11px;line-height:1.6">表示される日数・付与日はスタッフごとに異なります。</p>
    </div>
  `, "home");
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });

  const captures = [
    ["paid-leave-home-mobile.png", homeHtml()],
    ["paid-leave-request-mobile.png", requestHtml()],
    ["paid-leave-balance-mobile.png", balanceHtml()],
  ];

  for (const [filename, html] of captures) {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({
      path: path.join(OUTPUT_DIR, filename),
      fullPage: true,
    });
  }

  await browser.close();
  console.log(OUTPUT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
