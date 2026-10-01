const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'shift-admin-tab.tsx'), 'utf8')
const sourceFile = ts.createSourceFile('shift-admin-tab.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['load', 'saveShiftChanges'].includes(node.name?.text)) {
    functions.set(node.name.text, node.getText(sourceFile))
  }
  ts.forEachChild(node, visit)
}
visit(sourceFile)
assert.equal(functions.size, 2, 'Run the actual reload and save functions from the component')
const compiled = ts.transpileModule(
  [...functions.values()].join('\n') + '\nmodule.exports = { load, saveShiftChanges };',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText

async function save(options = {}) {
  const period = { id: 'test-period', department: '製造', status: 'editing' }
  const payload = {
    selectedPeriod: period,
    requirements: [{ work_date: '2026-10-02' }],
    assignments: [{ shift_label: '8:00-12:00' }],
    requests: [],
    cellStyles: [],
  }
  const savedPayloadRef = { current: structuredClone(payload) }
  const messages = []
  const savingKeys = []
  const patchCalls = []
  const reloadCalls = []
  const result = {
    finalized: true, requirements: 1, assignments: 1, requestChanges: 0,
    cellStyles: 0, confirmationAlerts: 3, ...options.result,
  }
  const dependencies = {
    selectedPeriod: period,
    payload,
    savedPayloadRef,
    isShiftLocked: options.locked || false,
    hasUnsavedChanges: true,
    window: { confirm: () => options.confirm !== false },
    setSavingKey: (key) => savingKeys.push(key),
    setMessage: (message) => messages.push(message),
    changedShiftRequests: () => [],
    patch: async (body) => {
      patchCalls.push(body)
      if (options.patchError) throw new Error(options.patchError)
      return result
    },
    isCompanyOffAssignment: () => false,
    periodId: period.id,
    department: period.department,
    loadSeqRef: { current: 0 },
    setIsLoading: () => {},
    fetch: async (url, init) => {
      reloadCalls.push({ url, init })
      return {
        ok: options.reloadOk !== false,
        json: async () => options.reloadOk === false
          ? { error: 'Synthetic reload failure' }
          : {
            ...payload,
            selectedPeriod: {
              ...period,
              id: options.reloadedId || period.id,
              status: options.reloadedStatus || 'confirmed',
            },
          },
      }
    },
    setPayload: () => {},
    cloneShiftPayload: (value) => structuredClone(value),
    setOpenTimeEditorKeys: () => {},
    setHasUnsavedChanges: () => {},
    setConfirmedNotesEditing: () => {},
    setDepartment: () => {},
    setPeriodId: () => {},
  }
  const loaded = { exports: {} }
  new Function('module', 'exports', ...Object.keys(dependencies), compiled)(
    loaded, loaded.exports, ...Object.values(dependencies),
  )
  const ok = await loaded.exports.saveShiftChanges(options.finalize !== false)
  return { ok, messages, savingKeys, patchCalls, reloadCalls, savedPayloadRef }
}

async function main() {
  const confirmed = await save()
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.patchCalls[0].finalize, true)
  assert.equal(confirmed.savedPayloadRef.current.selectedPeriod.status, 'confirmed')
  assert.match(confirmed.messages.at(-1), /シフトを確定保存し.*3名へ通知しました/)
  assert.match(confirmed.reloadCalls[0].url, /period_id=test-period/)
  assert.equal(confirmed.reloadCalls[0].init.cache, 'no-store')
  assert.equal(confirmed.savingKeys.at(-1), '')

  for (const options of [
    { result: { finalized: false } },
    { result: { finalized: undefined } },
    { result: { finalized: true }, reloadedStatus: 'editing' },
    { reloadedId: 'another-period' },
  ]) {
    const failed = await save(options)
    assert.equal(failed.ok, false, JSON.stringify(options))
    assert.match(failed.messages.at(-1), /確定状態を確認できません/)
    assert.ok(!failed.messages.some((message) => message.includes('シフトを確定保存し')))
    assert.equal(failed.savingKeys.at(-1), '')
  }

  const saveFailed = await save({ patchError: 'Synthetic paid leave sync failure' })
  assert.equal(saveFailed.ok, false)
  assert.equal(saveFailed.messages.at(-1), 'Synthetic paid leave sync failure')
  assert.equal(saveFailed.reloadCalls.length, 0)
  assert.equal(saveFailed.savedPayloadRef.current.selectedPeriod.status, 'editing')
  assert.equal(saveFailed.savingKeys.at(-1), '')

  const reloadFailed = await save({ reloadOk: false })
  assert.equal(reloadFailed.ok, false)
  assert.match(reloadFailed.messages.at(-1), /再読込に失敗しました/)
  assert.equal(reloadFailed.savingKeys.at(-1), '')

  const countMismatch = await save({ result: { assignments: 0 } })
  assert.equal(countMismatch.ok, false)
  assert.match(countMismatch.messages.at(-1), /保存件数の照合に失敗/)
  assert.equal(countMismatch.reloadCalls.length, 0)

  const temporary = await save({ finalize: false, result: { finalized: false }, reloadedStatus: 'editing' })
  assert.equal(temporary.ok, true, 'Temporary saving remains compatible')
  assert.equal(temporary.patchCalls[0].finalize, false)
  assert.equal(temporary.messages.at(-1), 'シフトを一時保存しました')

  for (const options of [{ confirm: false }, { locked: true }]) {
    const cancelled = await save(options)
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.patchCalls.length, 0)
    assert.equal(cancelled.reloadCalls.length, 0)
  }
  console.log('Shift confirmation UI tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
