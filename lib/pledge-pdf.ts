import path from 'node:path'
import PDFDocument from 'pdfkit'
import { jstDateText, type PledgeCheckItem } from '@/lib/pledges'

type SignedPledgePdfOptions = {
  title: string
  body: string
  checkItems: PledgeCheckItem[]
  agreementLabel: string
  companyName: string
  signerName: string
  pledgedAt: string
}

const MARGIN_X = 54
const MARGIN_TOP = 58
const MARGIN_BOTTOM = 52

function ensureSpace(document: PDFKit.PDFDocument, height: number) {
  if (document.y + height <= document.page.height - MARGIN_BOTTOM) return
  document.addPage()
}

function drawParagraphs(document: PDFKit.PDFDocument, text: string) {
  for (const paragraph of text.split(/\n\s*\n/)) {
    const clean = paragraph.trim()
    if (!clean) continue
    const isImportantHeading = clean === '【重要】'
    document
      .fontSize(isImportantHeading ? 11.5 : 10.5)
      .fillColor('#111827')
      .text(clean, MARGIN_X, document.y, {
        width: document.page.width - MARGIN_X * 2,
        lineGap: isImportantHeading ? 4 : 5,
      })
    document.moveDown(isImportantHeading ? 0.45 : 0.75)
  }
}

export async function createSignedPledgePdf(options: SignedPledgePdfOptions) {
  const fontPath = path.join(process.cwd(), 'assets', 'fonts', 'NotoSansJP-Regular.ttf')
  const document = new PDFDocument({
    size: 'A4',
    font: fontPath,
    margins: { top: MARGIN_TOP, right: MARGIN_X, bottom: MARGIN_BOTTOM, left: MARGIN_X },
    bufferPages: true,
    info: {
      Title: options.title,
      Author: options.companyName,
      Subject: `${options.signerName} 誓約書`,
    },
  })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
  })

  document.font(fontPath)

  document
    .fontSize(18)
    .fillColor('#0f172a')
    .text(options.title, MARGIN_X, document.y, {
      width: document.page.width - MARGIN_X * 2,
      align: 'center',
      lineGap: 4,
    })
  document.moveDown(1.35)

  const markerIndex = options.body.indexOf('【重要】')
  const introduction = markerIndex >= 0 ? options.body.slice(0, markerIndex).trim() : options.body
  const important = markerIndex >= 0 ? options.body.slice(markerIndex).trim() : ''
  drawParagraphs(document, introduction)

  document.moveDown(0.25)
  for (const item of options.checkItems) {
    document.fontSize(10.5)
    const textWidth = document.page.width - MARGIN_X * 2 - 28
    const textHeight = document.heightOfString(item.text, { width: textWidth, lineGap: 4 })
    const blockHeight = Math.max(25, textHeight + 8)
    ensureSpace(document, blockHeight + 7)
    const top = document.y
    document
      .save()
      .roundedRect(MARGIN_X, top + 1, 14, 14, 1.5)
      .fillAndStroke('#e0f2fe', '#2563eb')
      .restore()
    document
      .fontSize(11)
      .fillColor('#2563eb')
      .text('✓', MARGIN_X + 2, top - 1, { width: 12, lineBreak: false })
    document
      .fontSize(10.5)
      .fillColor('#111827')
      .text(item.text, MARGIN_X + 25, top, { width: textWidth, lineGap: 4 })
    document.y = top + blockHeight + 7
  }

  if (important) {
    document.moveDown(0.5)
    drawParagraphs(document, important)
  }

  ensureSpace(document, 140)
  document.moveDown(0.5)
  const signatureTop = document.y
  const signatureWidth = document.page.width - MARGIN_X * 2
  document
    .save()
    .roundedRect(MARGIN_X, signatureTop, signatureWidth, 116, 2)
    .fillAndStroke('#f8fafc', '#cbd5e1')
    .restore()
  document
    .fontSize(11)
    .fillColor('#16345c')
    .text(options.agreementLabel, MARGIN_X + 16, signatureTop + 15, { width: signatureWidth - 32 })
  document
    .fontSize(10.5)
    .fillColor('#111827')
    .text(`会社名: ${options.companyName}`, MARGIN_X + 16, signatureTop + 42, { width: signatureWidth - 32 })
    .text(`誓約者: ${options.signerName}`, MARGIN_X + 16, signatureTop + 66, { width: signatureWidth - 32 })
    .text(`誓約日: ${jstDateText(options.pledgedAt)}`, MARGIN_X + 16, signatureTop + 90, { width: signatureWidth - 32 })

  const range = document.bufferedPageRange()
  for (let index = 0; index < range.count; index += 1) {
    document.switchToPage(range.start + index)
    document
      .fontSize(8)
      .fillColor('#6b7280')
      .text(`${index + 1} / ${range.count}`, MARGIN_X, document.page.height - 34, {
        width: document.page.width - MARGIN_X * 2,
        align: 'right',
        lineBreak: false,
      })
  }

  document.end()
  return completed
}
