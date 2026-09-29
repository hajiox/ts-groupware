import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
export async function POST(request:NextRequest) {
  const body=await request.json().catch(()=>({}))
  const fields:Record<string,string>={received:'received_at',displayed:'displayed_at',clicked:'clicked_at',failed:'display_failed_at'}
  const field=fields[body.stage]
  if(!field || !/^[0-9a-f-]{36}$/i.test(body.token||'')) return NextResponse.json({error:'Invalid receipt'},{status:400})
  const {error}=await adminClient.from('gw_sos_deliveries').update({[field]:new Date().toISOString()}).eq('receipt_token',body.token).is(field,null).gt('created_at',new Date(Date.now()-7*86400000).toISOString())
  return NextResponse.json({ok:!error},{status:error?500:200})
}
