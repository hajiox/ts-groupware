import { timingSafeEqual } from 'node:crypto'
import { NextRequest,NextResponse } from 'next/server'
import {
  PAYROLL_MAIL_MAX_JSON_BYTES,PayrollMailError,getPayrollMailReceipt,
  parsePayrollMailInput,payrollMailReadiness,processPayrollMail,
} from '@/lib/payroll-mail-import'

export const runtime='nodejs'
export const maxDuration=60
function authorize(request:NextRequest) {
  const expected=process.env.TSG_PAYROLL_MAIL_SECRET?.trim()
  if(!expected) throw new PayrollMailError('not_configured',503)
  const header=request.headers.get('authorization')||''
  const bearer=header.startsWith('Bearer ')?header.slice(7):''
  const dedicated=request.headers.get('x-tsg-payroll-mail-secret')||''
  if(bearer&&dedicated&&bearer!==dedicated) throw new PayrollMailError('unauthorized',401)
  const actual=dedicated||bearer
  const a=Buffer.from(actual),b=Buffer.from(expected)
  if(a.length!==b.length||!timingSafeEqual(a,b)) throw new PayrollMailError('unauthorized',401)
}
function failure(error:unknown) {
  const known=error instanceof PayrollMailError
  return NextResponse.json({ok:false,error:known?error.code:'temporary_failure'},
    {status:known?error.status:503,headers:{'Cache-Control':'no-store'}})
}
export async function GET(request:NextRequest) {
  try {
    authorize(request)
    if([...request.nextUrl.searchParams.keys()].some(key=>key!=='sourceKey') || request.nextUrl.searchParams.getAll('sourceKey').length>1) {
      throw new PayrollMailError('invalid_query',400)
    }
    const sourceKey=request.nextUrl.searchParams.get('sourceKey')
    if(sourceKey!==null&&(!/^[A-Za-z0-9:_-]{1,200}$/.test(sourceKey))) throw new PayrollMailError('invalid_source_key',400)
    const result=sourceKey?await getPayrollMailReceipt(sourceKey):await payrollMailReadiness()
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
  } catch(error) {return failure(error)}
}
export async function POST(request:NextRequest) {
  try {
    authorize(request)
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')) throw new PayrollMailError('json_required',415)
    const length=Number(request.headers.get('content-length')||'0')
    if(length>PAYROLL_MAIL_MAX_JSON_BYTES) throw new PayrollMailError('request_too_large',413)
    const chunks:Uint8Array[]=[]
    let total=0
    if(!request.body) throw new PayrollMailError('invalid_request',400)
    const reader=request.body.getReader()
    try {
      for(;;) {
        const {value,done}=await reader.read()
        if(done) break
        total+=value.byteLength
        if(total>PAYROLL_MAIL_MAX_JSON_BYTES) {await reader.cancel();throw new PayrollMailError('request_too_large',413)}
        chunks.push(value)
      }
    } finally {reader.releaseLock()}
    let raw:unknown
    try {raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}
    catch {throw new PayrollMailError('invalid_json',400)}
    const result=await processPayrollMail(parsePayrollMailInput(raw))
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
  } catch(error) {return failure(error)}
}
