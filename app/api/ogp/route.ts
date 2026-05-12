import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/ogp?url=xxx
 *
 * URLからOGPメタデータ（タイトル、説明、画像）を取得。
 * CORSを回避するためサーバーサイドでfetchする。
 * 結果は Cache-Control で24時間キャッシュ。
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  try {
    new URL(url) // validate
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TSGroupwareBot/1.0)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
    }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      return NextResponse.json({ error: 'not html' }, { status: 400 })
    }

    // HTMLの先頭部分のみ読み込み（パフォーマンスのため）
    const reader = res.body?.getReader()
    if (!reader) {
      return NextResponse.json({ error: 'no body' }, { status: 502 })
    }

    let html = ''
    const decoder = new TextDecoder()
    while (html.length < 50000) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
      // </head>が見つかったら十分
      if (html.includes('</head>')) break
    }
    reader.cancel()

    // OGPタグを抽出
    const ogp: Record<string, string> = {}

    // og: tags
    const ogRegex = /<meta\s+(?:[^>]*?\s+)?(?:property|name)=["']og:([^"']+)["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["'][^>]*>/gi
    const ogRegex2 = /<meta\s+(?:[^>]*?\s+)?content=["']([^"']*)["']\s+(?:[^>]*?\s+)?(?:property|name)=["']og:([^"']+)["'][^>]*>/gi

    let match
    while ((match = ogRegex.exec(html)) !== null) {
      ogp[match[1]] = match[2]
    }
    while ((match = ogRegex2.exec(html)) !== null) {
      ogp[match[2]] = match[1]
    }

    // fallback: <title>
    if (!ogp.title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) ogp.title = titleMatch[1].trim()
    }

    // fallback: meta description
    if (!ogp.description) {
      const descMatch = html.match(/<meta\s+(?:[^>]*?\s+)?name=["']description["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["'][^>]*>/i)
        || html.match(/<meta\s+(?:[^>]*?\s+)?content=["']([^"']*)["']\s+(?:[^>]*?\s+)?name=["']description["'][^>]*>/i)
      if (descMatch) ogp.description = descMatch[1].trim()
    }

    // favicon fallback for image
    if (!ogp.image) {
      const iconMatch = html.match(/<link\s+[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["'][^>]*>/i)
        || html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/i)
      if (iconMatch) {
        const iconUrl = iconMatch[1]
        try {
          ogp.image = new URL(iconUrl, url).href
        } catch {
          // ignore
        }
      }
    }

    // image URLを絶対パスに
    if (ogp.image && !ogp.image.startsWith('http')) {
      try {
        ogp.image = new URL(ogp.image, url).href
      } catch {
        // ignore
      }
    }

    const result = {
      title: ogp.title || null,
      description: ogp.description?.slice(0, 200) || null,
      image: ogp.image || null,
      siteName: ogp.site_name || null,
      url,
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'timeout' }, { status: 504 })
    }
    return NextResponse.json({ error: 'fetch error' }, { status: 502 })
  }
}
