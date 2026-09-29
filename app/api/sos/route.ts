import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'
import { adminClient } from '@/lib/supabase/admin'
import { dispatchDueSos, getSosManagers, SOS_SELECT } from '@/lib/sos'
export const dynamic='force-dynamic'
export async function GET(request:NextRequest) {
  const user=await getUserSession()
  if(!user || !isManagementUser(user)) return NextResponse.json({error:'管理者のみ利用できます'},{status:403})
  let query=adminClient.from('gw_sos_alerts').select(SOS_SELECT).order('created_at',{ascending:false}).limit(100)
  if(request.nextUrl.searchParams.get('active')==='1') query=query.neq('status','resolved')
  const {data:alerts,error}=await query
  if(error) return NextResponse.json({error:'SOS取得失敗'},{status:500})
  if(request.nextUrl.searchParams.get('active')==='1') {
    const {count,error:subError}=await adminClient.from('gw_push_subscriptions').select('id',{count:'exact',head:true}).eq('user_id',user.id)
    if(subError) return NextResponse.json({error:'通知端末の確認失敗'},{status:500})
    return NextResponse.json({alerts,needsRegistration:!count},{headers:{'Cache-Control':'no-store'}})
  }
  const managers=await getSosManagers()
  const [deliveries,subscriptions]=await Promise.all([
    alerts?.length ? adminClient.from('gw_sos_deliveries').select('id,alert_id,user_id,attempt,created_at,accepted,failed,outcome,received_at,displayed_at,clicked_at,display_failed_at').in('alert_id',alerts.map(a=>a.id)).order('created_at',{ascending:false}).limit(1000) : Promise.resolve({data:[],error:null}),
    adminClient.from('gw_push_subscriptions').select('user_id').in('user_id',managers.map(u=>u.id)),
  ])
  if(deliveries.error || subscriptions.error) return NextResponse.json({error:'SOS通知状況取得失敗'},{status:500})
  return NextResponse.json({alerts,deliveries:deliveries.data,managers:managers.map(u=>({id:u.id,name:u.real_name||u.display_name,subscriptions:subscriptions.data?.filter(s=>s.user_id===u.id).length||0})),currentUserId:user.id},{headers:{'Cache-Control':'no-store'}})
}
export async function POST(request:NextRequest) {
  const user=await getUserSession()
  if(!user || !isManagementUser(user)) return NextResponse.json({error:'管理者のみ利用できます'},{status:403})
  const body=await request.json().catch(()=>({}))
  if(body.action==='heartbeat') {
    try { return NextResponse.json(await dispatchDueSos()) } catch { return NextResponse.json({error:'再通知処理に失敗しました'},{status:503}) }
  }
  if(!/^[0-9a-f-]{36}$/i.test(body.id||'') || !['acknowledge','resolve'].includes(body.action)) return NextResponse.json({error:'入力が不正です'},{status:400})
  const acknowledging=body.action==='acknowledge'
  const changes=acknowledging?{status:'acknowledged',acknowledged_by:user.id,acknowledged_name:user.display_name,acknowledged_at:new Date().toISOString(),next_notification_at:null}:{status:'resolved',resolved_at:new Date().toISOString(),next_notification_at:null}
  const {data,error}=await adminClient.from('gw_sos_alerts').update(changes).eq('id',body.id).eq('status',acknowledging?'pending':'acknowledged').select(SOS_SELECT).maybeSingle()
  if(error) return NextResponse.json({error:'SOS更新失敗'},{status:500})
  if(!data) return NextResponse.json({error:'別の管理者が状態を更新しました。再読込してください。'},{status:409})
  return NextResponse.json({alert:data})
}
