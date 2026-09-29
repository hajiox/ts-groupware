import { NextRequest, NextResponse } from 'next/server'
import { dispatchDueSos } from '@/lib/sos'
export const dynamic='force-dynamic'
export const maxDuration=60
export async function GET(request:NextRequest) {
  const secret=process.env.CRON_SECRET?.trim()
  if(!secret || request.headers.get('authorization')!==`Bearer ${secret}`) return NextResponse.json({error:'Unauthorized'},{status:401})
  try { return NextResponse.json(await dispatchDueSos()) }
  catch { return NextResponse.json({error:'SOS dispatch failed'},{status:500}) }
}
