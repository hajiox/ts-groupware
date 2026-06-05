import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

type GroupRow = {
  id: string
  name: string
  type: string
}

type MemberRow = {
  user_id: string
  role: string | null
}

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
  role?: string | null
  status?: string | null
}

const DEFAULT_GROUP_NAMES = [
  'TS(売上・新規・HAPPY！）',
  'TS(売上・新規・HAPPY!)',
  'TS（売上・新規・HAPPY！）',
  'TS（売上・新規・HAPPY!）',
]

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function assertIntegrationSecret(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  if (actual !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

function normalizeGroupName(name: string) {
  return name
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/！/g, '!')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_TSA_REPORT_GROUP_NAME?.trim()
  const targetNames = [...(configuredName ? [configuredName] : []), ...DEFAULT_GROUP_NAMES]
  const normalizedTargets = new Set(targetNames.map(normalizeGroupName))

  const { data: groups, error } = await adminClient
    .from('gw_groups')
    .select('id, name, type')
    .eq('type', 'board')

  if (error) throw new Error(error.message)

  const rows = (groups || []) as GroupRow[]
  const exact = rows.find(group => normalizedTargets.has(normalizeGroupName(group.name)))
  if (exact) return exact

  const fuzzy = rows.find(group => {
    const normalized = normalizeGroupName(group.name)
    return normalized.includes('売上') && normalized.includes('新規') && normalized.includes('happy')
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

async function getEligibleUsers(groupId: string) {
  const { data: members, error: memberError } = await adminClient
    .from('gw_group_members')
    .select('user_id, role')
    .eq('group_id', groupId)

  if (memberError) throw new Error(memberError.message)

  const memberRows = (members || []) as MemberRow[]
  const explicitMemberUserIds = new Set(memberRows.map(member => member.user_id))

  const { data: users, error: userError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role, status')
    .eq('status', 'approved')

  if (userError) throw new Error(userError.message)

  const memberRoleMap = new Map(memberRows.map(member => [member.user_id, member.role || 'member']))

  return ((users || []) as UserRow[])
    .filter(user => user.role === 'admin' || explicitMemberUserIds.has(user.id))
    .map(user => ({
      id: user.id,
      displayName: user.real_name || user.display_name,
      pictureUrl: user.picture_url || null,
      role: user.role || 'member',
      groupRole: user.role === 'admin' ? 'admin' : memberRoleMap.get(user.id) || 'member',
      implicitMember: user.role === 'admin' && !explicitMemberUserIds.has(user.id),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
}

export async function GET(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const group = await getTargetGroup()
    const users = await getEligibleUsers(group.id)

    return NextResponse.json({
      group: {
        id: group.id,
        name: group.name,
      },
      users,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load eligible users' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    const content = typeof body.content === 'string' ? body.content : ''

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }
    if (!content.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const users = await getEligibleUsers(group.id)
    const poster = users.find(user => user.id === userId)
    if (!poster) {
      return NextResponse.json({ error: 'Selected user does not have access to the target board' }, { status: 403 })
    }

    const { data: post, error } = await adminClient
      .from('gw_posts')
      .insert({
        group_id: group.id,
        user_id: userId,
        content,
        attachments: [],
        parent_id: null,
      })
      .select('id, group_id, user_id, content, created_at')
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || 'Failed to create post' }, { status: 500 })
    }

    await adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group.id)

    await import('@/lib/web-push')
      .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, userId, {
        title: `${group.name} - ${poster.displayName}`,
        body: content.substring(0, 80),
        url: `/board/${group.id}`,
        tag: `tsg-tsa-daily-report-${post.id}`,
      }, post.id))
      .catch(error => console.error('[TSA daily report push error]', error))

    return NextResponse.json({
      ok: true,
      group: {
        id: group.id,
        name: group.name,
      },
      poster,
      post,
      url: `/board/${group.id}`,
    }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create daily report post' },
      { status: 500 }
    )
  }
}
