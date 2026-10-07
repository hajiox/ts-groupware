const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Exercise the real component with a small hook/event model. This verifies the
// UI lifecycle; it does not model iOS browser selection or OAuth cookie storage.
const filename = path.join(__dirname, '..', 'app/login/page.tsx')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText + '\nmodule.exports.TestLoginContent = LoginContent;\n'

function events() {
  const listeners = new Map()
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    emit(name) { for (const listener of [...(listeners.get(name) || [])]) listener() },
    count(name) { return listeners.get(name)?.size || 0 },
  }
}

function createHarness(options = {}) {
  const calls = []
  const navigations = []
  const hooks = []
  const window = events()
  window.matchMedia = (query) => {
    assert.equal(query, '(display-mode: standalone)')
    return { matches: options.displayStandalone === true }
  }
  const document = Object.assign(events(), { visibilityState: 'visible' })
  const navigator = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 5,
    standalone: true,
    ...options.navigator,
  }
  const router = { replace: (url) => navigations.push(url) }
  const searchParams = new URLSearchParams(options.query || '')
  let cursor = 0
  let dirty = true
  let mounted = true
  let tree
  let lateStateWrites = 0
  let pendingEffects = []

  function hook(kind, initialize) {
    const index = cursor++
    if (!hooks[index]) hooks[index] = { kind, ...initialize() }
    assert.equal(hooks[index].kind, kind, 'Hook order must remain stable')
    return hooks[index]
  }

  const react = {
    Suspense: Symbol('Suspense'),
    useState(initial) {
      const state = hook('state', () => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, (value) => {
        if (!mounted) { lateStateWrites += 1; return }
        const next = typeof value === 'function' ? value(state.value) : value
        if (!Object.is(next, state.value)) { state.value = next; dirty = true }
      }]
    },
    useRef(initial) { return hook('ref', () => ({ current: initial })) },
    useEffect(effect, dependencies) {
      const state = hook('effect', () => ({ dependencies: undefined, cleanup: undefined }))
      const changed = !state.dependencies || !dependencies
        || dependencies.length !== state.dependencies.length
        || dependencies.some((value, index) => !Object.is(value, state.dependencies[index]))
      if (changed) {
        state.dependencies = dependencies ? [...dependencies] : undefined
        pendingEffects.push(() => {
          state.cleanup?.()
          state.cleanup = effect()
        })
      }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'next/navigation': { useRouter: () => router, useSearchParams: () => searchParams },
  }
  const loaded = { exports: {} }
  const context = vm.createContext({
    module: loaded,
    exports: loaded.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    // Only a fixed test origin is visible to the component; never load local env.
    process: { env: { NEXT_PUBLIC_SITE_URL: 'https://test.invalid' } },
    URL,
    window,
    document,
    navigator,
    fetch(url, init) {
      assert.equal(url, '/api/auth/me', 'The harness must never make network calls')
      assert.equal(init?.cache, 'no-store')
      let resolve
      let reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      calls.push({ url, init, resolve, reject })
      return promise
    },
  })
  new vm.Script(compiled, { filename }).runInContext(context)

  function render() {
    let iterations = 0
    while (mounted && dirty) {
      assert.ok(++iterations < 10, 'Unexpected render loop')
      dirty = false
      cursor = 0
      tree = loaded.exports.TestLoginContent()
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) effect()
    }
  }

  const harness = {
    calls,
    navigations,
    window,
    document,
    get tree() { return tree },
    get lateStateWrites() { return lateStateWrites },
    async flush() {
      // Allow the fetch and response.json continuations to finish before render.
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      render()
    },
    async respond(index, user = null) {
      calls[index].resolve({ ok: !!user, json: async () => ({ user }) })
      await harness.flush()
    },
    async reject(index) {
      calls[index].reject(new Error('Test-only connection failure'))
      await harness.flush()
    },
    resume(event = 'visibilitychange', visibility = 'visible') {
      document.visibilityState = visibility
      ;(event === 'pageshow' ? window : document).emit(event)
      render()
    },
    unmount() {
      mounted = false
      for (const state of hooks) if (state.kind === 'effect') state.cleanup?.()
    },
  }
  render()
  return harness
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}

function fallback(harness) {
  return nodes(harness.tree, (node) => node.type === 'a' && typeof node.props.href === 'string'
    && new URL(node.props.href).searchParams.get('browser') === '1')
}

function defaultLogin(harness) {
  return nodes(harness.tree, (node) => node.type === 'a' && node.props.className === 'btn-line')
}

async function main() {
  const devices = [
    { name: 'iPhone Home Screen', expected: true },
    { name: 'iPhone display-mode', navigator: { standalone: false }, displayStandalone: true, expected: true },
    { name: 'iPhone browser', navigator: { standalone: false }, expected: false },
    { name: 'iPad desktop UA', navigator: { userAgent: 'Macintosh', platform: 'MacIntel' }, expected: true },
    { name: 'Mac standalone', navigator: { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, expected: false },
    { name: 'Android standalone', navigator: { userAgent: 'Android', platform: 'Linux' }, expected: false },
  ]
  for (const device of devices) {
    const harness = createHarness({ ...device, query: 'error=state_mismatch&next=%2Fadmin%3Ftab%3Dshifts' })
    assert.equal(harness.calls.length, 0, 'An error screen must not start an initial session check')
    assert.equal(fallback(harness).length, Number(device.expected), device.name)
    const primary = new URL(defaultLogin(harness)[0].props.href)
    assert.equal(primary.origin, 'https://test.invalid')
    assert.equal(primary.pathname, '/api/auth/line')
    assert.equal(primary.searchParams.get('browser'), null, 'Keep the default LINE flow unchanged')
    assert.equal(primary.searchParams.get('next'), '/admin?tab=shifts')
    if (device.expected) {
      const link = fallback(harness)[0]
      const url = new URL(link.props.href)
      assert.equal(url.origin, primary.origin)
      assert.equal(url.pathname, primary.pathname)
      assert.equal(url.searchParams.get('next'), '/admin?tab=shifts')
      assert.equal(link.props.target, undefined, 'Do not request a separate browser window')
    }
    harness.unmount()
  }

  for (const next of ['https://attacker.invalid', '//attacker.invalid', '/login', '/api/auth/line']) {
    const harness = createHarness({ query: `error=state_mismatch&next=${encodeURIComponent(next)}` })
    assert.equal(new URL(fallback(harness)[0].props.href).searchParams.get('next'), null)
    harness.unmount()
  }

  const resumed = createHarness({ query: 'error=state_mismatch' })
  assert.equal(resumed.window.count('pageshow'), 1, 'Register resume handling even on an error screen')
  assert.equal(resumed.document.count('visibilitychange'), 1)
  resumed.resume('pageshow')
  resumed.resume()
  assert.equal(resumed.calls.length, 0, 'Resume before a fallback click must not fetch')
  fallback(resumed)[0].props.onClick()
  resumed.resume('visibilitychange', 'hidden')
  assert.equal(resumed.calls.length, 0, 'Do not fetch while hidden')
  resumed.resume()
  resumed.resume('pageshow')
  resumed.resume()
  assert.equal(resumed.calls.length, 1, 'Concurrent resume events must share one in-flight check')
  await resumed.respond(0, { id: 'test-only-user' })
  assert.deepEqual(resumed.navigations, ['/groups'], 'Navigate only after this context has a valid session')
  resumed.unmount()

  const failed = createHarness()
  assert.equal(failed.calls.length, 1, 'A normal login page checks the session on mount')
  assert.equal(defaultLogin(failed).length, 0, 'Initial session check shows its loading state')
  await failed.reject(0)
  assert.equal(defaultLogin(failed).length, 1, 'A failed check must leave login controls available')
  assert.equal(fallback(failed).length, 1)
  failed.resume('pageshow')
  assert.equal(failed.calls.length, 1, 'A failed initial check must not enable automatic retry')
  fallback(failed)[0].props.onClick()
  failed.resume()
  await failed.reject(1)
  assert.equal(defaultLogin(failed).length, 1, 'A failed resume check must preserve login controls')
  assert.equal(fallback(failed).length, 1)
  assert.deepEqual(failed.navigations, [])
  assert.equal(failed.calls.length, 2, 'Connection failures must not start a retry loop')
  failed.unmount()

  const cleanup = createHarness({ query: 'error=state_mismatch' })
  fallback(cleanup)[0].props.onClick()
  cleanup.resume()
  assert.equal(cleanup.calls.length, 1)
  cleanup.unmount()
  assert.equal(cleanup.window.count('pageshow'), 0)
  assert.equal(cleanup.document.count('visibilitychange'), 0)
  cleanup.resume()
  cleanup.resume('pageshow')
  assert.equal(cleanup.calls.length, 1, 'Unmount must remove both resume listeners')
  await cleanup.respond(0, { id: 'test-only-user' })
  assert.deepEqual(cleanup.navigations, [], 'A late response must not navigate after unmount')
  assert.equal(cleanup.lateStateWrites, 0, 'A late response must not update unmounted state')

  console.log('PWA login tests passed: device visibility, safe links, error resume, in-flight guard, failure and cleanup')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
