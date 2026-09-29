'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
type Alert={id:string;device_name:string;created_at:string;status:string;acknowledged_name:string|null;dispatch_count:number}
type Delivery={alert_id:string;user_id:string;attempt:number;accepted:number;failed:number;outcome:string;received_at:string|null;displayed_at:string|null;clicked_at:string|null;display_failed_at:string|null}
type Manager={id:string;name:string;subscriptions:number}
export function SosPanel({history=false,deviceKey}:{history?:boolean;deviceKey?:string}) {
  const [alerts,setAlerts]=useState<Alert[]>([])
  const [deliveries,setDeliveries]=useState<Delivery[]>([])
  const [managers,setManagers]=useState<Manager[]>([])
  const [allowed,setAllowed]=useState(false)
  const [error,setError]=useState('')
  const [needsRegistration,setNeedsRegistration]=useState(false)
  const hasPending=alerts.some(a=>a.status==='pending')
  const [busy,setBusy]=useState(false)
  const endpoint=deviceKey?`/api/time-clock/${deviceKey}/sos`:'/api/sos'
  const load=useCallback(async()=>{
    try {
      const response=await fetch(endpoint+(!deviceKey&&!history?'?active=1':''),{cache:'no-store'})
      if(response.status===403) {setAllowed(false);return}
      const data=await response.json()
      if(!response.ok) throw new Error(data.error||'SOS状況を取得できません')
      setNeedsRegistration(Boolean(data.needsRegistration));setAllowed(true);setAlerts(deviceKey?(data.alert?[data.alert]:[]):data.alerts||[])
      setDeliveries(data.deliveries||[]);setManagers(data.managers||[]);setError('')
    } catch {setError('SOS状況を確認できません。通信を確認して再読込してください。')}
  },[endpoint,deviceKey,history])
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),10000);window.addEventListener('tsg:sos-refresh',load);return()=>{clearInterval(timer);window.removeEventListener('tsg:sos-refresh',load)}},[load])
  useEffect(()=>{
    if(!allowed||!hasPending) return
    let running=false
    const heartbeat=async()=>{if(running)return;running=true;try {const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'heartbeat'})});if(!res.ok)setError('再通知処理を確認できません。必要な場合は電話でも連絡してください。')}catch{setError('再通知処理を確認できません。')}finally{running=false}}
    const timer=setInterval(()=>void heartbeat(),10000)
    return()=>clearInterval(timer)
  },[allowed,hasPending,endpoint])
  async function act(id:string,action:string) {
    setBusy(true)
    try {const response=await fetch('/api/sos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action})});const data=await response.json();if(!response.ok)throw new Error(data.error);await load();window.dispatchEvent(new Event('tsg:sos-refresh'))}catch(e){setError(e instanceof Error?e.message:'更新失敗')}finally{setBusy(false)}
  }
  if(!allowed&&!error) return history?<p>管理者でログインしてください。</p>:null
  return <section style={{margin:'12px auto',maxWidth:850,padding:alerts.length||history||error?16:0}} aria-label="SOS状況">
    {allowed&&!deviceKey&&needsRegistration&&<p role="alert" style={{padding:12,border:'2px solid #f59e0b'}}>SOSを受け取る通知端末が未登録です。本人のスマホで<Link href="/settings">通知設定を開き、通知を許可して登録</Link>してください。</p>}
    {error&&<p role="alert" style={{color:'#ef4444'}}>{error}</p>}
    {history&&<><h1>道の駅 SOS・通知履歴</h1><p>未対応の場合は2分経過後に再通知します。「対応します」で再通知を停止し、対応後に「対応完了」を押してください。</p><p>端末画面が閉じている場合も定期処理で再通知します（実行のタイミングにより最大約1分遅れることがあります）。</p><p><Link href="/settings">通知設定・受信テスト</Link> ／ <Link href="/notifications">通知一覧</Link></p><ul>{managers.map(m=><li key={m.id}>{m.name}：{m.subscriptions?`${m.subscriptions}端末登録`:'通知端末未登録・本人の端末で通知設定が必要'}</li>)}</ul></>}
    {history&&!alerts.length&&<p>SOSの記録はありません。</p>}
    {alerts.map(a=><article key={a.id} style={{background:a.status==='pending'?'#7f1d1d':'#163a35',color:'#fff',border:'2px solid '+(a.status==='pending'?'#ef4444':'#34d399'),borderRadius:12,padding:16,marginBottom:12}}>
      <strong>{a.status==='pending'?'🚨 SOS 未対応':a.status==='acknowledged'?'SOS 対応中':'SOS 対応完了'} — {a.device_name}</strong>
      <p>{new Date(a.created_at).toLocaleString('ja-JP')}</p>
      <p>{a.status==='pending'?'受付済み・管理者の確認待ち':`${a.acknowledged_name||'管理者'}が${a.status==='resolved'?'対応を完了しました':'対応します'}`}</p>
      {!deviceKey&&<>{a.status==='pending'&&<button disabled={busy} onClick={()=>act(a.id,'acknowledge')} style={{padding:'12px 20px',background:'#fff',color:'#7f1d1d',borderRadius:8,fontWeight:700}}>対応します（再通知停止）</button>}{a.status==='acknowledged'&&<button disabled={busy} onClick={()=>act(a.id,'resolve')} style={{padding:12,background:'#fff',color:'#163a35',borderRadius:8}}>対応完了</button>} {!history&&<Link href="/sos" style={{color:'#fff',textDecoration:'underline'}}>通知状況・履歴を見る</Link>}</>}
      {history&&<><p>通知処理：{a.dispatch_count}回。サービス受付と端末表示は別の記録です。</p><ul>{managers.map(m=>{const d=deliveries.find(d=>d.alert_id===a.id&&d.user_id===m.id);return <li key={m.id}>{m.name}：{!d?'送信記録なし':`直近${d.attempt}回目・サービス受付${d.accepted}件／失敗${d.failed}件・${d.outcome==='no_subscription'?'端末未登録':d.outcome==='not_configured'?'通知鍵未設定':d.outcome==='sending'?'処理中または中断':d.outcome==='subscription_error'?'端末取得失敗':d.clicked_at?'通知を開いた':d.displayed_at?'表示処理成功（本人確認ではありません）':d.display_failed_at?'端末表示失敗':d.received_at?'端末受信済み・表示未確認':'端末受信未確認'}`}</li>})}</ul><details><summary>送信履歴（直近取得分）</summary><ul>{deliveries.filter(d=>d.alert_id===a.id).map((d,i)=><li key={i}>{managers.find(m=>m.id===d.user_id)?.name||'管理者'}・{d.attempt}回目・受付{d.accepted}／失敗{d.failed}・{d.outcome}</li>)}</ul></details></>}
    </article>)}
  </section>
}
