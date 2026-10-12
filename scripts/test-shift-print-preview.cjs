const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");

// Render the real preview and shell with synthetic schedules, then inspect
// Chrome's actual paginated PDF. No application server, account, or printer.
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function bundleFixture() {
  const virtual = {
    entry: compile(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import PrintPage from 'fixture-print';
      import { AppShell } from 'fixture-shell';
      createRoot(document.getElementById('root')).render(<AppShell>
        <main style={{ flex: 1 }}><div className="app-shell__alerts" /><PrintPage /></main>
      </AppShell>);
    `),
    "fixture-print": compile(read("app/admin/shifts/print/page.tsx")),
    "fixture-shell": compile(read("components/app-shell.tsx")),
    "next/navigation": "exports.usePathname = () => '/admin/shifts/print';",
  };
  const modules = new Map();
  function add(id) {
    if (modules.has(id)) return;
    const code = virtual[id] ?? (id.endsWith(".ts") ? compile(fs.readFileSync(id, "utf8")) : fs.readFileSync(id, "utf8"));
    const dependencies = {};
    modules.set(id, { code, dependencies });
    for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = match[1];
      const dependency = Object.hasOwn(virtual, name) ? name
        : name.startsWith("@/") ? path.join(root, `${name.slice(2)}.ts`)
          : require.resolve(name, { paths: [Object.hasOwn(virtual, id) ? root : path.dirname(id)] });
      dependencies[name] = dependency;
      add(dependency);
    }
  }
  add("entry");
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
    load('entry');
  })();`;
}

function schedule(department, employeeCount, days) {
  const employees = Array.from({ length: employeeCount }, (_, index) => ({
    id: `employee-${index}`, user_id: `user-${index}`, employee_code: String(index + 1),
    display_name: `検証担当${index + 1}`, real_name: null, work_style: "full_time_part",
  }));
  const dates = Array.from({ length: days }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
  return {
    selectedPeriod: { id: "fixture", department, title: `${department} 印刷検証`, start_date: dates[0], end_date: dates.at(-1) },
    employees,
    assignments: dates.flatMap(work_date => employees.map(({ user_id }) => ({ user_id, work_date, shift_label: "09:00-18:00", note: null }))),
    requirements: dates.map(work_date => ({ work_date, workplace_label: null, notes: "検証用備考", notes2: "", notes3: "", production_plan: "", timee_count: 0, ec_sale_tags: [], ec_sale_times: {} })),
    requests: [], holidays: [], saleOptions: [], cellStyles: [],
  };
}

function pdfPages(pdf) {
  // Chrome writes uncompressed page dictionaries even though content streams
  // are compressed. Read their MediaBox and compare actual output page sizes.
  const dictionaries = [...pdf.toString("latin1").matchAll(/\d+\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*endobj/g)]
    .map(match => match[1]).filter(value => /\/Type\s*\/Page\b/.test(value));
  return dictionaries.map(value => {
    const box = value.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
    assert.ok(box, "Chrome page dictionary must include its paper size");
    return { width: Number(box[3]) - Number(box[1]), height: Number(box[4]) - Number(box[2]) };
  });
}

async function render(browser, bundle, css, payload) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }));
  await page.goto("https://shift-print.test/admin/shifts/print?period_id=fixture");
  await page.addStyleTag({ content: css });
  await page.evaluate((data) => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
    window.fetch = async (url, options) => {
      if (url !== "/api/admin/shifts?period_id=fixture" || options?.cache !== "no-store") throw new Error("Unexpected fixture request");
      return { ok: true, json: async () => data };
    };
  }, payload);
  await page.addScriptTag({ content: bundle });
  await page.locator(".shift-print-sheet").first().waitFor();
  await page.getByRole("button", { name: "印刷", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__printCalls), 1, "preview print button invokes the browser print command");
  const sheets = await page.locator(".shift-print-sheet").count();
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".shift-print-toolbar").isVisible(), false, "print controls are omitted from paper");
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  assert.deepEqual(errors, []);
  await page.close();
  return { sheets, pages: pdfPages(pdf) };
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  try {
    const bundle = bundleFixture();
    const css = read("app/globals.css");
    if (process.env.SHIFT_PRINT_BASELINE_REF) {
      const oldCss = execFileSync("git", ["show", `${process.env.SHIFT_PRINT_BASELINE_REF}:app/globals.css`], { cwd: root, encoding: "utf8", maxBuffer: 5_000_000 });
      const old = await render(browser, bundle, oldCss, schedule("フロア", 8, 16));
      assert.equal(old.pages.length, 2, "negative control reproduces the extra first page");
      assert.ok(old.pages[0].height > old.pages[0].width, "negative control starts on the shared portrait page");
      assert.ok(old.pages[1].width > old.pages[1].height, "negative control puts the schedule on the second landscape page");
      console.log("PASS: baseline reproduces a portrait first page before the landscape schedule");
    }
    for (const fixture of [
      { department: "フロア", employees: 8, days: 16, expected: 1 },
      { department: "フロア", employees: 8, days: 31, expected: 2 },
      { department: "製造", employees: 11, days: 31, expected: 4 },
      { department: "道の駅", employees: 4, days: 15, expected: 1 },
    ]) {
      const { sheets, pages } = await render(browser, bundle, css, schedule(fixture.department, fixture.employees, fixture.days));
      assert.equal(sheets, fixture.expected, `${fixture.department}: preserve employee/date grouping`);
      assert.equal(pages.length, fixture.expected, `${fixture.department}: each preview sheet prints once without a leading blank or overflow page`);
      for (const page of pages) {
        assert.ok(Math.abs(page.width - 841.89) < 1 && Math.abs(page.height - 595.28) < 1, `${fixture.department}: every page must be A4 landscape`);
      }
      console.log(`PASS: ${fixture.department}, ${fixture.employees} staff / ${fixture.days} days => ${pages.length} A4 landscape page(s)`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
