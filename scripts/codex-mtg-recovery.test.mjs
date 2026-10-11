import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Worker, createApi, inspectRestart, restartDecision, writeRestartLatch } from './codex-mtg-worker.mjs'

const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sourceDir = dirname(fileURLToPath(import.meta.url))
const powerShell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tsg-mtg-recovery-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\tsg-mtg-recovery-') || resolve(root).startsWith(resolve(tmpdir()) + '/tsg-mtg-recovery-')); rmSync(root, { recursive: true, force: true }) })
  return root
}

test('restart gate permits only idle crashes and does not infer safety from an exit code', () => {
  const ready = { version: 1, mode: 'ready', reason: null, workerPid: 123, updatedAt: new Date().toISOString() }
  assert.equal(restartDecision().decision, 'start')
  assert.equal(restartDecision({ latch: ready, journal: { phase: 'acknowledged', jobId } }).decision, 'start')
  for (const journal of [{ phase: 'running', jobId }, { phase: 'completion_pending', completion: { jobId, leaseToken: 'synthetic-secret' } }, { phase: 'acknowledged' }, {}, []]) assert.equal(restartDecision({ latch: ready, journal }).decision, 'blocked')
  for (const reason of ['authentication_required', 'lease_uncertain', 'completion_uncertain', 'execution_uncertain', 'job_invalid', 'crash_limit', 'intentional_stop']) assert.equal(restartDecision({ latch: { ...ready, mode: 'blocked', reason } }).decision, 'blocked')
  assert.equal(restartDecision({ latch: { ...ready, mode: 'anything' } }).decision, 'blocked')
  assert.equal(restartDecision({ unreadable: true }).decision, 'blocked')
  assert.equal(restartDecision({ liveWorker: true, heartbeatFresh: false }).reason, 'worker_alive_stale')
})

test('malformed, unreadable or oversized state blocks; live and stale worker PIDs are never restarted', t => {
  const root = fixture(t), monitor = join(root, 'monitor.json')
  assert.equal(inspectRestart(root, () => false, monitor).decision, 'start')
  writeFileSync(join(root, 'worker.lock'), '123')
  writeFileSync(monitor, JSON.stringify({ bridgePid: 123, heartbeatAt: new Date().toISOString() }))
  assert.equal(inspectRestart(root, () => true, monitor).reason, 'worker_alive')
  writeFileSync(monitor, JSON.stringify({ bridgePid: 123, heartbeatAt: '2000-01-01', status: 'running' }))
  assert.equal(inspectRestart(root, () => true, monitor).reason, 'worker_alive_stale')
  assert.equal(inspectRestart(root, () => { throw Error('Process access denied') }, monitor).decision, 'blocked')
  writeFileSync(join(root, 'worker.lock'), 'not-a-pid')
  assert.equal(inspectRestart(root, () => false, monitor).decision, 'blocked')
  rmSync(join(root, 'worker.lock'))
  writeFileSync(join(root, 'job-state.json'), '{')
  assert.equal(inspectRestart(root, () => false, monitor).decision, 'blocked')
  writeFileSync(join(root, 'job-state.json'), 'x'.repeat(16385))
  assert.equal(inspectRestart(root, () => false, monitor).decision, 'blocked')
  rmSync(join(root, 'job-state.json'))
  writeFileSync(monitor, JSON.stringify({ status: 'waiting_for_user' }))
  assert.equal(inspectRestart(root, () => false, monitor).reason, 'legacy_operator_wait')
  writeRestartLatch(root, 'blocked', 'authentication_required')
  assert.equal(inspectRestart(root, () => false, monitor).reason, 'authentication_required')
  assert.equal(readFileSync(join(root, 'restart-state.json'), 'utf8').includes('leaseToken'), false)
  writeFileSync(join(root, 'restart-state.json'), '')
  assert.equal(inspectRestart(root, () => false, monitor).decision, 'blocked')
})

test('HTML 401 and 403 responses durably stop authentication before any retry', async t => {
  for (const status of [401, 403]) {
    const root = fixture(t); let calls = 0
    const config = { root, pcName: 'TSA', token: 'synthetic-private-token', endpoint: 'https://synthetic.invalid' }
    const api = createApi(config, async () => { calls++; return new Response('<html>Access denied</html>', { status }) })
    const worker = new Worker(config, { api, monitor: () => {}, restartBlock: reason => writeRestartLatch(root, 'blocked', reason) })
    await worker.wake(); await worker.wake()
    assert.equal(worker.authenticationRequired, true); assert.equal(calls, 1)
    assert.equal(inspectRestart(root, () => false, join(root, 'monitor.json')).reason, 'authentication_required')
    assert.equal(readFileSync(join(root, 'restart-state.json'), 'utf8').includes(config.token), false)
  }
})

function launcherFixture(t, scenario) {
  const fixtureRoot = fixture(t), root = join(fixtureRoot, 'physical-local', 'TSG Codex MTG')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'skill')); writeFileSync(join(root, 'skill/SKILL.md'), 'Synthetic scoped Skill')
  writeFileSync(join(root, 'worker.config.json'), '{"synthetic":true}')
  const workerModule = pathToFileURL(join(sourceDir, 'codex-mtg-worker.mjs')).href
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario))
  writeFileSync(join(root, 'worker.mjs'), `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRestart, restartDecision, writeMonitor, writeRestartLatch } from ${JSON.stringify(workerModule)};
const root = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
if (process.argv.includes('--check')) { process.exitCode = scenario.badConfig ? 1 : 0; }
else if (process.argv.includes('--restart-check')) {
  const result = scenario.alive ? restartDecision({liveWorker:true,heartbeatFresh:!scenario.stale}) : inspectRestart(root, () => false, join(root, 'monitor.json'));
  process.stdout.write(JSON.stringify(result)); process.exitCode = result.exitCode;
} else {
  const configIndex=process.argv.indexOf('--config');
  writeFileSync(join(root,'paths.json'), JSON.stringify({runtimeDir:root,localAppData:process.env.LOCALAPPDATA,configPath:process.argv[configIndex+1],configExists:existsSync(process.argv[configIndex+1]),skillExists:existsSync(join(root,'skill','SKILL.md')),launcherLockExists:existsSync(join(root,'launcher.lock'))}));
  writeMonitor({pcName:'SYNTHETIC'},{status:'idle'});
  const countFile = join(root, 'starts'); const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) + 1 : 1;
  writeFileSync(countFile, String(count)); writeRestartLatch(root, 'ready');
  if (scenario.auth) writeRestartLatch(root, 'blocked', 'authentication_required');
  if (scenario.unknown) writeFileSync(join(root, 'job-state.json'), JSON.stringify({phase:'running',jobId:${JSON.stringify(jobId)},leaseToken:'synthetic-private-lease'}));
  if (scenario.hold) while (!existsSync(join(root, 'release'))) await new Promise(accept => setTimeout(accept, 20));
  process.exitCode = scenario.alwaysCrash || scenario.auth || scenario.unknown || scenario.crashOnce && count === 1 ? 137 : 0;
}
`)
  // Only the test clock is shortened. No runtime or task is installed or started.
  const launcher = readFileSync(join(sourceDir, 'start-codex-mtg-worker.ps1'), 'utf8').replace('__TSG_VERIFIED_NODE_PATH__', process.execPath.replaceAll("'", "''")).replace('Start-Sleep -Seconds 15', 'Start-Sleep -Milliseconds 1')
  const path = join(root, 'start-worker.ps1'); writeFileSync(path, '\ufeff' + launcher)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path]
  const run = () => spawnSync(powerShell, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const starts = () => existsSync(join(root, 'starts')) ? Number(readFileSync(join(root, 'starts'), 'utf8')) : 0
  const status = () => JSON.parse(readFileSync(join(root, 'startup-status.json'), 'utf8'))
  return { fixtureRoot, root, args, run, starts, status }
}

test('Windows launcher recovers one safe crash, leaves intentional clean exit stopped, and caps repeated crashes', { skip: process.platform !== 'win32' }, t => {
  const once = launcherFixture(t, { crashOnce: true }); assert.equal(once.run().status, 0); assert.equal(once.starts(), 2)
  const clean = launcherFixture(t, {}); assert.equal(clean.run().status, 0); assert.equal(clean.starts(), 1)
  const repeated = launcherFixture(t, { alwaysCrash: true }); assert.equal(repeated.run().status, 0); assert.equal(repeated.starts(), 5); assert.equal(repeated.status().step, 'crash_limit')
  assert.equal(repeated.run().status, 0); assert.equal(repeated.starts(), 5); assert.equal(repeated.status().step, 'operator_review_required')
})

test('Windows launcher never retries invalid config, authentication waits, uncertain journals or an existing worker', { skip: process.platform !== 'win32' }, t => {
  for (const scenario of [{ badConfig: true }, { auth: true }, { unknown: true }, { alive: true }, { alive: true, stale: true }]) {
    const f = launcherFixture(t, scenario); const result = f.run()
    assert.equal(result.status, scenario.badConfig ? 1 : 0, result.stderr)
    assert.equal(f.starts(), scenario.auth || scenario.unknown ? 1 : 0)
    if (scenario.stale) assert.equal(f.status().step, 'worker_alive_stale')
    if (scenario.badConfig) { assert.equal(f.run().status, 0); assert.equal(f.status().step, 'operator_review_required') }
  }
})

test('Windows concurrent launcher invocation cannot start a duplicate worker', { skip: process.platform !== 'win32' }, async t => {
  const f = launcherFixture(t, { hold: true })
  const first = spawn(powerShell, f.args, { windowsHide: true, stdio: 'ignore' })
  const finished = new Promise(accept => first.once('exit', accept))
  t.after(() => { if (first.exitCode === null) first.kill() })
  const deadline = Date.now() + 10000
  while (!f.starts() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 20))
  assert.equal(f.starts(), 1)
  assert.equal(f.run().status, 0); assert.equal(f.starts(), 1)
  writeFileSync(join(f.root, 'release'), '')
  assert.equal(await finished, 0)
})

test('Windows logical runtime resolves to one physical task entry and the same private runtime and monitor', { skip: process.platform !== 'win32' }, t => {
  const f = launcherFixture(t, {}), physicalRoot = realpathSync.native(f.root)
  const logicalRuntime = join(f.fixtureRoot, 'logical-local', 'TSG Codex MTG')
  mkdirSync(dirname(logicalRuntime), { recursive: true }); symlinkSync(physicalRoot, logicalRuntime, 'junction')
  assert.notEqual(logicalRuntime.toLowerCase(), physicalRoot.toLowerCase())
  const installer = readFileSync(join(sourceDir, 'install-codex-mtg-worker.ps1'), 'utf8')
  const resolver = installer.slice(installer.indexOf('$runtimeLocationJson ='), installer.indexOf('$powerShellPath ='))
  const argumentAssignment = installer.split(/\r?\n/).find(line => line.startsWith('$arguments ='))
  const probe = join(f.fixtureRoot, 'resolve-physical.ps1')
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  writeFileSync(probe, '\ufeff' + `$ErrorActionPreference='Stop'\n$nodePath=${quote(process.execPath)}\n$installPath=${quote(logicalRuntime)}\n${resolver}\n${argumentAssignment}\n@{runtimeDir=$physicalRuntimeDir;launcherPath=$physicalLauncherPath;arguments=$arguments}|ConvertTo-Json -Compress`)
  const resolution = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(resolution.status, 0, resolution.stderr)
  const entry = JSON.parse(resolution.stdout)
  assert.equal(entry.runtimeDir.toLowerCase(), physicalRoot.toLowerCase())
  assert.equal(entry.launcherPath.toLowerCase(), join(physicalRoot, 'start-worker.ps1').toLowerCase())
  assert.equal(entry.arguments.includes('"' + entry.launcherPath + '"'), true)
  // Invoke the logical spelling too: the launcher itself must canonicalize it.
  const result = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(logicalRuntime, 'start-worker.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, LOCALAPPDATA: dirname(logicalRuntime) } })
  assert.equal(result.status, 0, result.stderr); assert.equal(f.starts(), 1)
  const observed = JSON.parse(readFileSync(join(f.root, 'paths.json'), 'utf8'))
  assert.equal(observed.runtimeDir.toLowerCase(), physicalRoot.toLowerCase())
  assert.equal(observed.localAppData.toLowerCase(), dirname(physicalRoot).toLowerCase())
  assert.equal(observed.configPath.toLowerCase(), join(physicalRoot, 'worker.config.json').toLowerCase())
  assert.equal(observed.configExists && observed.skillExists && observed.launcherLockExists, true)
  const monitor = JSON.parse(readFileSync(join(dirname(physicalRoot), 'Codex Bridge Monitor/states/tsg-codex-mtg.json'), 'utf8'))
  assert.equal(monitor.workerName, 'SYNTHETIC')
})

test('explicit operator restart of the actual worker retains an uncertain journal and never claims or runs AI', t => {
  const root = fixture(t)
  mkdirSync(join(root, 'skill')); writeFileSync(join(root, 'skill/SKILL.md'), 'Synthetic scoped Skill')
  writeFileSync(join(root, 'config.toml'), 'model="synthetic-user-model"\n[windows]\nsandbox="elevated"\n')
  const configFile = join(root, 'worker.config.json')
  writeFileSync(configFile, JSON.stringify({ token: 'tsg_mtg_' + 'x'.repeat(43), pcName: 'TSA', codexHome: root, codexPath: process.execPath, workspaceRoot: join(root, 'work') }))
  const saved = { phase: 'running', jobId, leaseToken: 'synthetic-private-lease' }
  writeFileSync(join(root, 'job-state.json'), JSON.stringify(saved)); writeRestartLatch(root, 'blocked', 'lease_uncertain')
  const preload = join(root, 'fake-api.mjs')
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
const calls=[];
globalThis.fetch=async (_url,init)=>{ calls.push(init.body ? JSON.parse(init.body).action : 'read'); writeFileSync(${JSON.stringify(join(root, 'calls.json'))},JSON.stringify(calls)); setImmediate(()=>process.emit('SIGTERM')); return new Response('synthetic denied',{status:401}); };
globalThis.WebSocket=class{constructor(){throw Error('Realtime must not start');}};
`)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(sourceDir, 'codex-mtg-worker.mjs'), '--config', configFile, '--operator-restart'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, LOCALAPPDATA: root } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'job-state.json'), 'utf8')), saved)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'calls.json'), 'utf8')), ['read'])
  assert.equal(existsSync(join(root, 'work')), false)
})
