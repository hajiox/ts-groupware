import http from 'node:http'
import { google } from 'googleapis'

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || `http://localhost:${process.env.GOOGLE_DRIVE_OAUTH_PORT || 53682}/oauth2callback`
const redirectUrl = new URL(redirectUri)
const port = Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80))
const codeArgIndex = process.argv.indexOf('--code')

if (!clientId || !clientSecret) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)

if (codeArgIndex >= 0) {
  const code = process.argv[codeArgIndex + 1]
  if (!code) {
    console.error('Usage: node scripts/google-drive-oauth-token.mjs --code <authorization_code>')
    process.exit(1)
  }

  const { tokens } = await oauth2Client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned. Revoke app access and run again, or ensure prompt=consent is used.')
  }

  console.log(tokens.refresh_token)
  process.exit(0)
}

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  login_hint: process.env.GOOGLE_DRIVE_LOGIN_HINT,
})

if (process.argv.includes('--print-url')) {
  console.log(authUrl)
  process.exit(0)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', redirectUri)

    if (url.pathname !== redirectUrl.pathname) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const code = url.searchParams.get('code')
    if (!code) {
      throw new Error(url.searchParams.get('error') || 'Authorization code is missing')
    }

    const { tokens } = await oauth2Client.getToken(code)
    if (!tokens.refresh_token) {
      throw new Error('No refresh_token returned. Revoke app access and run again, or ensure prompt=consent is used.')
    }

    console.log('\nGOOGLE_DRIVE_REFRESH_TOKEN=')
    console.log(tokens.refresh_token)
    console.log('\nAdd this value to Vercel Production as GOOGLE_DRIVE_REFRESH_TOKEN.')

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>認証完了</h1><p>このタブは閉じてOKです。ターミナルに refresh token が表示されています。</p>')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(error instanceof Error ? error.message : 'OAuth failed')
  } finally {
    server.close()
  }
})

server.listen(port, () => {
  console.log(`Open this URL and authorize Google Drive access:\n\n${authUrl}\n`)
  console.log(`Redirect URI: ${redirectUri}`)
})
