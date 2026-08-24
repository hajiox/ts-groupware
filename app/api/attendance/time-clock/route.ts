import { NextResponse } from 'next/server'

const TERMINAL_ONLY_MESSAGE = '打刻は業務場所に設置した専用タイムレコーダー端末で行ってください'

export async function GET() {
  return NextResponse.json(
    { error: TERMINAL_ONLY_MESSAGE, code: 'time_clock_terminal_only' },
    { status: 410 },
  )
}

export async function POST() {
  return NextResponse.json(
    { error: TERMINAL_ONLY_MESSAGE, code: 'time_clock_terminal_only' },
    { status: 410 },
  )
}
