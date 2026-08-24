import { extractTextFromPdfWithDriveOcr } from '@/lib/drive'

export type ResumeOcrResult = {
  full_name: string | null
  name_kana: string | null
  birth_date: string | null
  gender: 'male' | 'female' | 'other' | 'unknown' | null
  postal_code: string | null
  address: string | null
  phone: string | null
  email: string | null
  education_history: string[]
  work_history: string[]
  qualifications: string[]
  personal_statement: string | null
  other_notes: string | null
}

export type ResumeOcrExtraction = {
  result: ResumeOcrResult
  provider: string
  model: string
}

export const RESUME_OCR_PROVIDER = 'google-gemini'
export const RESUME_OCR_MODEL = process.env.GEMINI_OCR_MODEL?.trim() || 'gemini-3.1-flash-lite'

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    full_name: { type: 'STRING' },
    name_kana: { type: 'STRING' },
    birth_date: { type: 'STRING' },
    gender: { type: 'STRING', enum: ['male', 'female', 'other', 'unknown'] },
    postal_code: { type: 'STRING' },
    address: { type: 'STRING' },
    phone: { type: 'STRING' },
    email: { type: 'STRING' },
    education_history: { type: 'ARRAY', items: { type: 'STRING' } },
    work_history: { type: 'ARRAY', items: { type: 'STRING' } },
    qualifications: { type: 'ARRAY', items: { type: 'STRING' } },
    personal_statement: { type: 'STRING' },
    other_notes: { type: 'STRING' },
  },
  required: [
    'full_name',
    'name_kana',
    'birth_date',
    'gender',
    'postal_code',
    'address',
    'phone',
    'email',
    'education_history',
    'work_history',
    'qualifications',
    'personal_statement',
    'other_notes',
  ],
}

const EXTRACTION_PROMPT = `日本語の履歴書PDFを読み取り、人事管理用の情報をJSONで抽出してください。

厳守事項:
- PDFに明記された情報だけを抽出し、推測や補完をしない
- 判読できない項目や記載がない項目は空文字または空配列にする
- 生年月日は西暦 YYYY-MM-DD に変換する。年月日が揃わない場合は空文字にする
- 性別は male / female / other / unknown のいずれかにする。記載がない場合は unknown にする
- 学歴、職歴、資格は日付と内容を一つの文字列にまとめ、原文の順番で配列にする
- マイナンバー、口座番号など、このJSON項目にない機微情報は出力しない
- JSON以外の文章を返さない`

function cleanString(value: unknown, maxLength = 4000) {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().slice(0, maxLength)
  return cleaned || null
}

function cleanList(value: unknown, maxItems = 80) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanString(item, 500))
    .filter((item): item is string => !!item)
    .slice(0, maxItems)
}

function cleanDate(value: unknown) {
  const date = cleanString(value, 10)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date
}

function cleanGender(value: unknown): ResumeOcrResult['gender'] {
  return value === 'male' || value === 'female' || value === 'other' || value === 'unknown'
    ? value
    : null
}

function normalizeResult(value: unknown): ResumeOcrResult {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    full_name: cleanString(record.full_name, 100),
    name_kana: cleanString(record.name_kana, 100),
    birth_date: cleanDate(record.birth_date),
    gender: cleanGender(record.gender),
    postal_code: cleanString(record.postal_code, 20),
    address: cleanString(record.address, 500),
    phone: cleanString(record.phone, 50),
    email: cleanString(record.email, 200),
    education_history: cleanList(record.education_history),
    work_history: cleanList(record.work_history),
    qualifications: cleanList(record.qualifications),
    personal_statement: cleanString(record.personal_statement, 4000),
    other_notes: cleanString(record.other_notes, 2000),
  }
}

function compactLabel(value: string) {
  return value.normalize('NFKC').replace(/[\s　]+/g, '')
}

function labeledValue(lines: string[], labels: string[]) {
  const normalizedLabels = labels.map(compactLabel)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const compact = compactLabel(line)
    for (const label of normalizedLabels) {
      if (!compact.startsWith(label)) continue
      const sourceLabel = line.match(/^([^:：]+)[:：]/)?.[1]
      const remainder = sourceLabel
        ? line.slice(line.indexOf(sourceLabel) + sourceLabel.length).replace(/^\s*[:：]\s*/, '').trim()
        : compact.slice(label.length).replace(/^[:：]/, '').trim()
      if (remainder) return remainder
      if (lines[index + 1]) return lines[index + 1].trim()
    }
  }
  return null
}

function parseJapaneseDate(value: string | null) {
  if (!value) return null
  const normalized = value.normalize('NFKC').replace(/[\s　]+/g, '')
  const western = normalized.match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/)
  if (western) {
    return cleanDate(`${western[1]}-${western[2].padStart(2, '0')}-${western[3].padStart(2, '0')}`)
  }

  const eraMatch = normalized.match(/(明治|大正|昭和|平成|令和)(元|\d{1,2})年(\d{1,2})月(\d{1,2})日/)
  if (!eraMatch) return null
  const eraStarts: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 }
  const eraYear = eraMatch[2] === '元' ? 1 : Number(eraMatch[2])
  const year = eraStarts[eraMatch[1]] + eraYear
  return cleanDate(`${year}-${eraMatch[3].padStart(2, '0')}-${eraMatch[4].padStart(2, '0')}`)
}

const SECTION_LABELS = [
  '学歴',
  '職歴',
  '免許・資格',
  '免許資格',
  '資格',
  '志望動機',
  '自己PR',
  '本人希望記入欄',
]

function sectionLines(lines: string[], headings: string[]) {
  const headingLabels = headings.map(compactLabel)
  const allLabels = SECTION_LABELS.map(compactLabel)
  const start = lines.findIndex((line) => headingLabels.includes(compactLabel(line).replace(/[:：]$/, '')))
  if (start < 0) return []

  const items: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const compact = compactLabel(line).replace(/[:：]$/, '')
    if (allLabels.some((label) => compact === label || compact.startsWith(`${label}:`) || compact.startsWith(`${label}：`))) break
    if (line) items.push(line)
  }
  return items.slice(0, 80)
}

function extractPattern(text: string, pattern: RegExp) {
  return text.match(pattern)?.[0]?.trim() || null
}

function parseDriveOcrText(text: string): ResumeOcrResult {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
  const normalizedText = lines.join('\n').normalize('NFKC')
  const genderText = labeledValue(lines, ['性別'])
  let gender: ResumeOcrResult['gender'] = null
  if (genderText && /女性|女/.test(genderText)) gender = 'female'
  else if (genderText && /男性|男/.test(genderText)) gender = 'male'
  else if (genderText) gender = 'other'

  const name = labeledValue(lines, ['氏名', '名前'])
  const kana = labeledValue(lines, ['ふりがな', 'フリガナ', '氏名カナ'])
  const birthText = labeledValue(lines, ['生年月日'])
  const postal = labeledValue(lines, ['郵便番号'])
    || extractPattern(normalizedText, /〒?\s*\d{3}[-ー‐−]?\d{4}/)
  const phone = labeledValue(lines, ['電話番号', '電話', '携帯電話'])
    || extractPattern(normalizedText, /0\d{1,4}[-ー‐−]\d{1,4}[-ー‐−]\d{3,4}/)
  const email = labeledValue(lines, ['メールアドレス', 'メール', 'E-mail', 'Email'])
    || extractPattern(normalizedText, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)

  return normalizeResult({
    full_name: name,
    name_kana: kana,
    birth_date: parseJapaneseDate(birthText),
    gender,
    postal_code: postal?.replace(/^〒\s*/, '') || null,
    address: labeledValue(lines, ['現住所', '住所']),
    phone,
    email,
    education_history: sectionLines(lines, ['学歴']),
    work_history: sectionLines(lines, ['職歴']),
    qualifications: sectionLines(lines, ['免許・資格', '免許資格', '資格']),
    personal_statement: labeledValue(lines, ['志望動機', '自己PR']),
    other_notes: labeledValue(lines, ['本人希望記入欄', '備考']),
  })
}

async function extractResumeWithGemini(pdf: Buffer): Promise<ResumeOcrResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new Error('AI OCR設定がありません（GEMINI_API_KEY）')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(RESUME_OCR_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: EXTRACTION_PROMPT },
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 4096,
        },
      }),
    },
  )

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    console.error('[Resume OCR] Gemini API error:', response.status, detail)
    throw new Error(`AI OCRに失敗しました（Gemini ${response.status}）`)
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim()
  if (!text) throw new Error('AI OCRの解析結果が空でした')

  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return normalizeResult(JSON.parse(jsonText))
  } catch {
    throw new Error('AI OCRの解析結果を読み取れませんでした')
  }
}

export async function extractResumeFromPdf(pdf: Buffer): Promise<ResumeOcrExtraction> {
  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      return {
        result: await extractResumeWithGemini(pdf),
        provider: RESUME_OCR_PROVIDER,
        model: RESUME_OCR_MODEL,
      }
    } catch (error) {
      console.warn('[Resume OCR] Gemini unavailable; falling back to Google Drive OCR:', error instanceof Error ? error.message : error)
    }
  }

  const text = await extractTextFromPdfWithDriveOcr(pdf, '履歴書.pdf')
  const result = parseDriveOcrText(text)
  const extractedCount = [
    result.full_name,
    result.name_kana,
    result.birth_date,
    result.address,
    result.phone,
    result.email,
    ...result.education_history,
    ...result.work_history,
    ...result.qualifications,
  ].filter(Boolean).length
  if (!extractedCount) throw new Error('履歴書から人事情報を読み取れませんでした')

  return {
    result,
    provider: 'google-drive-ocr',
    model: 'drive-ocr-ja',
  }
}
