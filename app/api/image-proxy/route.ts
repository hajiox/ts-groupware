import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function isAllowedImageHost(hostname: string) {
  return (
    hostname === 'drive.google.com' ||
    hostname === 'lh3.googleusercontent.com' ||
    hostname.endsWith('.googleusercontent.com')
  )
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawUrl = request.nextUrl.searchParams.get('url')
  if (!rawUrl) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 })
  }

  if (target.protocol !== 'https:' || !isAllowedImageHost(target.hostname)) {
    return NextResponse.json({ error: 'Image host is not allowed' }, { status: 400 })
  }

  const upstream = await fetch(target.toString(), { cache: 'no-store' })
  if (!upstream.ok) {
    return NextResponse.json({ error: 'Image fetch failed' }, { status: upstream.status })
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  if (!contentType.toLowerCase().startsWith('image/')) {
    return NextResponse.json({ error: 'Target is not an image' }, { status: 400 })
  }

  const contentLength = Number(upstream.headers.get('content-length') || 0)
  if (contentLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image is too large' }, { status: 413 })
  }

  const body = await upstream.arrayBuffer()
  if (body.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image is too large' }, { status: 413 })
  }

  return new NextResponse(body, {
    headers: {
      'Cache-Control': 'private, max-age=300',
      'Content-Type': contentType,
    },
  })
}
