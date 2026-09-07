import { createHash } from 'node:crypto'

const reasons = {
  browser_access: '取得workerがブラウザアクセス制限を報告し、CSV取得が完了しませんでした。実際の原因はログと画面で確認が必要です。ブラウザ未起動や配送会社サイトの制限が原因と確定したわけではありません。',
  login_required: '配送会社サイトのログインまたは本人確認が必要です。',
  share_unavailable: 'CSV保存先の共有フォルダにアクセスできませんでした。',
  csv_missing: '対象月のCSVが共有フォルダに見つからず、取込が完了していません。',
  import_failed: 'CSVの検証またはデータベース取込に失敗しました。',
  execution_failed: '出荷取込処理が完了せず停止しました。ローカルアプリで詳細を確認してください。',
} as const

export function carrierImportAlert(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body is invalid')
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some(key => !['sourceKey', 'period', 'carriers', 'reason', 'status'].includes(key))) {
    throw new Error('body is invalid')
  }
  const { sourceKey, period, carriers, reason, status } = body
  if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(sourceKey)) throw new Error('sourceKey is invalid')
  if (typeof period !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('period is invalid')
  if (!Array.isArray(carriers) || carriers.length < 1 || carriers.length > 2
    || carriers.some(carrier => carrier !== 'yamato' && carrier !== 'sagawa')
    || new Set(carriers).size !== carriers.length) throw new Error('carriers is invalid')
  if (typeof reason !== 'string' || !Object.hasOwn(reasons, reason)) throw new Error('reason is invalid')
  if (!['needs_operator', 'failed', 'recovered'].includes(status as string)) throw new Error('status is invalid')
  const names = ['yamato', 'sagawa'].filter(carrier => carriers.includes(carrier)).map(carrier => carrier === 'yamato' ? 'ヤマト' : '佐川').join('・')
  const url = `http://192.168.110.200:3003/?carrierImport=${period}#carrier-import`
  const content = status === 'recovered'
    ? `【出荷データ取込・復旧】${period} ${names}\n対象月のCSV取込が完了しました。件数・取込結果は出荷データ管理で確認してください。\n${url}`
    : `【出荷データ取込・要対応】${period} ${names}\n${reasons[reason as keyof typeof reasons]}\n\n対応手順\n1. 社内PCで出荷データ管理を開き、対象月と実行結果を確認します。\n2. 共有フォルダ・ローカルアプリの稼働を確認します。CSV取得が必要な場合は、このPCのChromeで対象の配送会社サイトにログインし、ブラウザ接続・操作権限を確認します。\n3. 下の画面で対象月を確認して「実行」を押します。リンクを開くだけでは実行されません。既存のCSVは再利用され、重複データは通常スキップされます。\n4. 完了件数を確認してください。ログイン・本人確認・権限待ちは繰り返し実行せず、表示された案内に対応してください。\n\n出荷データ管理（社内ネットワークのみ）\n${url}`
  return { sourceKey, content }
}

export function carrierImportAlertPostId(sourceKey: string) {
  const bytes = createHash('sha256').update(`tsa_carrier_import_alert:${sourceKey}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
