import { adminClient } from '@/lib/supabase/admin'
import { sendPushNotificationToUserWithResult } from '@/lib/web-push'
import { isManagementUser } from '@/lib/user-roles'

export const SOS_SELECT = 'id,device_id,device_name,created_at,status,acknowledged_name,acknowledged_at,resolved_at,next_notification_at,dispatch_count'
export async function getSosManagers() {
  const { data, error } = await adminClient.from('gw_users').select('id,role,display_name,real_name').eq('status','approved')
  if (error) throw new Error('SOS宛先を取得できません')
  return (data || []).filter(u => isManagementUser(u) && u.display_name !== 'TSG君')
}

export async function dispatchDueSos(alertId?: string) {
  const managers = await getSosManagers()
  const { data: alerts, error } = await adminClient.rpc('gw_claim_due_sos', { p_alert_id: alertId || null })
  if (error) throw new Error('SOS再通知を開始できません')
  for (const alert of alerts || []) {
    for (const user of managers) {
      // Acknowledgement stops subsequent dispatches, including this batch.
      const { data: current, error: checkError } = await adminClient.from('gw_sos_alerts').select('status').eq('id',alert.id).single()
      if (checkError) throw new Error('SOS状態を確認できません')
      if (current?.status !== 'pending') break
      const { data: delivery, error: insertError } = await adminClient.from('gw_sos_deliveries').insert({ alert_id: alert.id,user_id:user.id,attempt:alert.dispatch_count }).select('id,receipt_token').single()
      if (insertError || !delivery) throw new Error('SOS送信履歴を保存できません')
      let result
      try {
        result = await sendPushNotificationToUserWithResult(user.id, {
          title: alert.dispatch_count > 1 ? '【未対応・再通知】道の駅 SOS' : '【緊急】道の駅 SOS',
          body: `${alert.device_name}からSOS。対応できる方は「対応します」を押してください。`,
          url: '/sos',tag:`tsg-sos-${alert.id}`,sosReceiptToken:delivery.receipt_token,
        })
      } catch {
        result = { accepted:0,failed:1,outcome:'failed' }
      }
      const { error: saveError } = await adminClient.from('gw_sos_deliveries').update(result).eq('id',delivery.id)
      if (saveError) throw new Error('SOS送信結果を保存できません')
    }
  }
  return { processed: (alerts || []).length }
}

export async function getSosDevice(deviceKey: string) {
  const { data } = await adminClient.from('gw_attendance_devices').select('id,name,code,location').eq('device_key',deviceKey).eq('is_active',true).maybeSingle()
  if (!data || !`${data.code} ${data.name} ${data.location}`.match(/michinoeki|道の駅/)) return null
  return data
}
