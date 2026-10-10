'use client'

import { useCallback, useEffect, useState } from 'react'
import { DATA_READ_SCOPES, DATA_WRITE_SCOPES, DATA_PUBLISH_SCOPES, type DataOperation } from '@/lib/data-api-policy'
import styles from './data-connections-panel.module.css'

type Board = { id: string; name: string }
type Connection = { id: string; label: string; scopes: DataOperation[]; allowed_group_ids: string[]; all_boards: boolean; pc_name: string | null; expires_at: string; revoked_at: string | null }
type Proposal = {
  id: string; connection_label: string; connection_id: string; digest: string; status: string; expires_at: string
  diff: { before: Record<string, unknown>; after: { group_id: string; group_name: string; content: string } }
}
type Audit = { id: string; connection_id: string; operation: string; created_at: string; before_data: unknown; after_data: unknown }
type Snapshot = { connections: Connection[]; boards: Board[]; principal: { name: string } }
const labels: Record<DataOperation, string> = {
  'boards.list': '掲示板の一覧', 'posts.search': '投稿の検索', 'posts.get': '投稿の詳細',
  'knowledge.search': '固定投稿の検索', 'knowledge.get': '固定投稿の詳細',
  'drafts.get': 'この接続の下書き詳細', 'drafts.list': 'この接続の下書き一覧',
  'tasks.search': '自分のタスク検索', 'tasks.get': '自分のタスク詳細',
  'drafts.create': '下書き作成', 'drafts.update': '下書き編集', 'tasks.complete': '自分のタスク完了',
  'posts.publish.prepare': '公開内容を準備', 'posts.publish.commit': '準備した投稿を公開',
}
const groups = [
  { title: '読み取り', scopes: DATA_READ_SCOPES },
  { title: '限定した更新', scopes: DATA_WRITE_SCOPES },
  { title: '投稿の公開', scopes: DATA_PUBLISH_SCOPES },
]
const endpoint = '/api/admin/data-connections'
async function call<T>(view = 'list', body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(body ? endpoint : `${endpoint}?view=${view}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error?.message || '取得できませんでした')
  return result.data as T
}
function time(value: string) { return new Date(value).toLocaleString('ja-JP') }

export function DataConnectionsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [audit, setAudit] = useState<Audit[]>([])
  const [label, setLabel] = useState('')
  const [days, setDays] = useState(7)
  const [scopes, setScopes] = useState<DataOperation[]>([...DATA_READ_SCOPES])
  const [boards, setBoards] = useState<string[]>([])
  const [allBoards, setAllBoards] = useState(false)
  const [pcName, setPcName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    const [next, confirmations, history] = await Promise.all([
      call<Snapshot>(), call<{ confirmations: Proposal[] }>('list_confirmations'), call<{ audit: Audit[] }>('list_audit'),
    ])
    setSnapshot(next); setProposals(confirmations.confirmations); setAudit(history.audit)
  }, [])
  useEffect(() => { void load().catch(e => setError(e.message)) }, [load])

  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : '更新できませんでした') }
    finally { setBusy(false) }
  }
  async function create() {
    setToken('')
    const result = await call<{ token: string }>('list', {
      action: 'create', label, scopes, allowedGroupIds: allBoards ? [] : boards, allBoards, pcName: pcName || null,
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(), maxLimit: 20,
    })
    setToken(result.token); setLabel(''); await load(); setNotice('接続キーを発行しました。表示は今回限りです。')
  }
  function toggleScope(scope: DataOperation) { setScopes(current => current.includes(scope) ? current.filter(s => s !== scope) : [...current, scope]) }

  return <section className={styles.panel} aria-label="外部Codex接続">
    <h2>外部Codex接続</h2>
    <p>接続ごとに、特定の掲示板または全掲示板を許可できます。全掲示板には今後追加する掲示板も含まれます。</p>
    <p>依頼した投稿は、接続元のCodexから追加承認なしで公開できます。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => void action(load)}>再読込</button>
    {token && <aside className={styles.secret}>
      <strong>接続キー（一度だけ表示）</strong>
      <p>利用するCodexの環境変数 TSG_DATA_API_TOKEN に設定してください。紛失した場合は失効して再発行します。</p>
      <textarea aria-label="発行した接続キー" readOnly value={token} rows={3} spellCheck={false} />
      <div className={styles.actions}>
        <button type="button" onClick={() => void action(async () => { await navigator.clipboard.writeText(token); setNotice('コピーしました') })}>コピー</button>
        <button type="button" onClick={() => setToken('')}>キーを画面から消す</button>
      </div>
    </aside>}
    <details className={styles.card}>
      <summary>新しい接続を作成</summary>
      <form onSubmit={event => { event.preventDefault(); void action(create) }}>
        <label className={styles.field}>接続名<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} placeholder="利用者・用途" /></label>
        <label className={styles.field}>有効期間<select value={days} onChange={e => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map(value => <option key={value} value={value}>{value}日</option>)}
        </select></label>
        <label className={styles.field}>登録PC名（TSG君として投稿する場合）<input value={pcName} maxLength={64} onChange={e => setPcName(e.target.value)} placeholder="例：CEO_S" /></label>
        <label><input type="checkbox" checked={allBoards} onChange={e => setAllBoards(e.target.checked)} />全掲示板を許可（新しく作る掲示板も含む）</label>
        <fieldset disabled={allBoards}><legend>利用できる掲示板（限定接続は20件まで）</legend>
          <div className={styles.checks}>{snapshot?.boards.map(board => <label key={board.id}>
            <input type="checkbox" checked={boards.includes(board.id)} disabled={!boards.includes(board.id) && boards.length >= 20}
              onChange={e => setBoards(current => e.target.checked ? [...current, board.id] : current.filter(id => id !== board.id))} />{board.name}（{board.id.slice(0, 8)}）
          </label>)}</div>
        </fieldset>
        {groups.map(group => <fieldset key={group.title}><legend>{group.title}</legend>
          <div className={styles.checks}>{group.scopes.map(scope => <label key={scope}>
            <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />{labels[scope]}
          </label>)}</div>
        </fieldset>)}
        <p>固定投稿は、掲示板で固定されている投稿です。タスクは本人が担当するものに限ります。</p>
        <button type="submit" disabled={busy || !label.trim() || (!allBoards && !boards.length) || !scopes.length}>選択した範囲でキーを発行</button>
      </form>
    </details>
    <h3>発行した接続</h3>
    {!snapshot && <p>読み込み中…</p>}
    {snapshot && !snapshot.connections.length && <p>接続はありません。</p>}
    {snapshot?.connections.map(connection => <article key={connection.id} className={styles.card}>
      <strong>{connection.label}</strong>
      <p>{connection.revoked_at ? `失効済み：${time(connection.revoked_at)}` : `有効期限：${time(connection.expires_at)}`}</p>
      <p>掲示板：{connection.all_boards ? '全掲示板（今後の追加も含む）' : connection.allowed_group_ids.map(id => snapshot.boards.find(b => b.id === id)?.name || id).join('、')}</p>
      {connection.pc_name && <p>投稿名義：TSG君 ／ PC：{connection.pc_name}</p>}
      <p>操作：{connection.scopes.map(scope => labels[scope]).join('、')}</p>
      <small>接続ID：{connection.id}</small>
      {!connection.revoked_at && Date.parse(connection.expires_at) > Date.now() && <button type="button" disabled={busy} onClick={() => { setEditing(editing === connection.id ? null : connection.id); setAllBoards(connection.all_boards); setBoards(connection.allowed_group_ids); setScopes(connection.scopes); setPcName(connection.pc_name || '') }}>権限を変更</button>}
      {editing === connection.id && <form onSubmit={event => { event.preventDefault(); void action(async () => {
        await call('list', { action: 'permissions', id: connection.id, scopes, allowedGroupIds: allBoards ? [] : boards, allBoards, pcName: pcName || null }); await load(); setEditing(null); setNotice('キーと有効期限を維持して権限を更新しました')
      }) }}>
        <label><input type="checkbox" checked={allBoards} onChange={e => setAllBoards(e.target.checked)} />全掲示板（今後の追加も含む）</label>
        <label className={styles.field}>登録PC名<input value={pcName} maxLength={64} onChange={e => setPcName(e.target.value)} placeholder="例：CEO_S" /></label>
        <fieldset disabled={allBoards}><legend>限定する掲示板</legend><div className={styles.checks}>{snapshot.boards.map(board => <label key={board.id}><input type="checkbox" checked={boards.includes(board.id)} disabled={!boards.includes(board.id) && boards.length >= 20} onChange={e => setBoards(current => e.target.checked ? [...current, board.id] : current.filter(id => id !== board.id))} />{board.name}</label>)}</div></fieldset>
        <button type="button" onClick={() => setScopes([...DATA_READ_SCOPES, ...DATA_WRITE_SCOPES, ...DATA_PUBLISH_SCOPES])}>全操作を選択</button>
        {groups.map(group => <fieldset key={group.title}><legend>{group.title}</legend><div className={styles.checks}>{group.scopes.map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />{labels[scope]}</label>)}</div></fieldset>)}
        <button type="submit" disabled={busy || !scopes.length || (!allBoards && !boards.length)}>権限を保存</button>
        <button type="button" onClick={() => setEditing(null)}>閉じる</button>
      </form>}
      {!connection.revoked_at && <div className={styles.actions}><button type="button" disabled={busy} onClick={() => {
        if (window.confirm(`「${connection.label}」を失効します。以後このキーは利用できません。`)) void action(async () => {
          await call('list', { action: 'revoke', id: connection.id }); await load(); setNotice('接続を失効しました')
        })
      }}>失効する</button></div>}
    </article>)}
    <h3>投稿の公開履歴</h3>
    {!proposals.length && <p>公開の準備・履歴はありません。</p>}
    {proposals.map(proposal => {
      const pending = ['pending', 'approved'].includes(proposal.status) && Date.parse(proposal.expires_at) > Date.now()
      const status = proposal.status === 'committed' ? '公開済み' : pending ? '準備済み・公開待ち' : '期限切れ'
      return <article key={proposal.id} className={styles.card}>
        <strong>{proposal.connection_label} — {status}</strong>
        <p>投稿先：<a href={`/board/${proposal.diff.after.group_id}`} target="_blank" rel="noopener noreferrer">{proposal.diff.after.group_name}（{proposal.diff.after.group_id.slice(0, 8)}）</a> ／ 期限：{time(proposal.expires_at)}</p>
        <p>新規投稿する本文</p><pre>{proposal.diff.after.content}</pre>
        <details><summary>変更前の状態</summary><pre>{JSON.stringify(proposal.diff.before, null, 2)}</pre></details>

      </article>
    })}
    <details className={styles.card}><summary>操作履歴（直近20件）</summary>
      {!audit.length && <p>履歴はありません。</p>}
      {audit.map(entry => <details key={entry.id} className={styles.history}>
        <summary>{time(entry.created_at)} — {labels[entry.operation as DataOperation] || entry.operation}</summary>
        <p>接続ID：{entry.connection_id}</p>
        <p>変更前</p><pre>{JSON.stringify(entry.before_data, null, 2)}</pre>
        <p>変更後</p><pre>{JSON.stringify(entry.after_data, null, 2)}</pre>
      </details>)}
    </details>
  </section>
}
