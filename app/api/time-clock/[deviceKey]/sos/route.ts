import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { dispatchDueSos, getSosDevice, SOS_SELECT } from '@/lib/sos'
export const dynamic = 'force-dynamic'
type Context = {params:Promise<{deviceKey:string}>}
export async function GET(_request:NextRequest,context:Context) {
  const device=await getSosDevice((await context.params).deviceKey)
  if(!device) return NextResponse.json({error:'道の駅端末が見つかりません'},{status:404})
  const {data,error}=await adminClient.from('gw_sos_alerts').select(SOS_SELECT).eq('device_id',device.id).order('created_at',{ascending:false}).limit(1).maybeSingle()
  if(error) return NextResponse.json({error:'SOS状態を取得できません'},{status:500})
  return NextResponse.json({alert:data},{headers:{'Cache-Control':'no-store'}})
}
export async function POST(request:NextRequest,context:Context) {
  const device=await getSosDevice((await context.params).deviceKey)
  if(!device) return NextResponse.json({error:'道の駅端末が見つかりません'},{status:404})
  const body=await request.json().catch(()=>({}))
  if(body.action==='heartbeat') {
    const {data,error}=await adminClient.from('gw_sos_alerts').select('id').eq('device_id',device.id).eq('status','pending').maybeSingle()
    if(error) return NextResponse.json({error:'SOS状態取得に失敗しました'},{status:500})
    try { if(data) await dispatchDueSos(data.id) } catch { return NextResponse.json({error:'SOS再通知を確認できません'},{status:503}) }
    return NextResponse.json({ok:true})
  }
  const {data,error}=await adminClient.rpc('gw_create_sos',{p_device_id:device.id})
  if(error || !data) return NextResponse.json({error:'SOSを受付できません。電話で管理者へ連絡してください。'},{status:500})
  let dispatchError=false
  try { await dispatchDueSos(data.id) } catch { dispatchError=true }
  return NextResponse.json({ok:true,alert:data,dispatchError,message:data.status==='acknowledged'?`${data.acknowledged_name||'管理者'}が対応します`:dispatchError?'SOS受付済み。通知処理に遅延があります。電話でも連絡してください。':'SOS受付済み・管理者の確認待ち'})
}
