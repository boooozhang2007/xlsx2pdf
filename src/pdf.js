import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { wrapText } from './utils'

const MM_TO_PT = 72 / 25.4
const mm = (value) => value * MM_TO_PT
const PAGE_WIDTH = mm(210)
const PAGE_HEIGHT = mm(297)
const MARGIN_X = mm(17)
const MARGIN_TOP = mm(16)
const MARGIN_BOTTOM = mm(15)

const PALETTE = {
  ink: rgb(0.09, 0.1, 0.12),
  muted: rgb(0.38, 0.41, 0.47),
  pale: rgb(0.95, 0.96, 0.98),
  line: rgb(0.84, 0.86, 0.9),
  accent: rgb(0.05, 0.36, 0.92),
  white: rgb(1, 1, 1),
}

const drawText = (page, text, options) => {
  page.drawText(String(text ?? ''), options)
}

const drawWrapped = (page, lines, x, y, options) => {
  const { font, size, color, lineHeight, maxLines = lines.length } = options
  lines.slice(0, maxLines).forEach((line, index) => {
    drawText(page, line, {
      x,
      y: y - index * lineHeight,
      size,
      font,
      color,
    })
  })
}

const getSafeFileBase = (name = 'example.xlsx') => {
  const base = name.replace(/\.[^.]+$/, '') || 'example'
  return `${base}.pdf`
}

export const createPdfFromRows = async (rows, config, inputFileName = 'example.xlsx') => {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)

  const [regularBytes, boldBytes] = await Promise.all([
    fetch('/NotoSansSC-Regular.otf').then((res) => res.arrayBuffer()),
    fetch('/NotoSansSC-Bold.otf').then((res) => res.arrayBuffer()),
  ])

  const regularFont = await pdfDoc.embedFont(regularBytes, { subset: true })
  const boldFont = await pdfDoc.embedFont(boldBytes, { subset: true })

  const title = config.title?.trim() || getSafeFileBase(inputFileName).replace(/\.pdf$/i, '')
  const wrapChars = Number(config.wrapChars) || 26
  const showIndex = config.showIndex !== false

  const contentWidth = PAGE_WIDTH - MARGIN_X * 2
  const indexW = showIndex ? mm(12) : 0
  const gap = mm(5)
  const englishW = mm(57)
  const chineseW = contentWidth - indexW - englishW - gap * (showIndex ? 2 : 1)
  const rowLineHeight = 14.5
  const minRowHeight = 30
  const topStart = PAGE_HEIGHT - MARGIN_TOP
  const bodyBottom = MARGIN_BOTTOM + mm(9)

  let pageNumber = 0
  let page
  let y

  const addPage = () => {
    pageNumber += 1
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = topStart

    drawText(page, title, {
      x: MARGIN_X,
      y,
      size: 19,
      font: boldFont,
      color: PALETTE.ink,
    })
    drawText(page, 'XLSX2PDF · 英汉对照', {
      x: PAGE_WIDTH - MARGIN_X - regularFont.widthOfTextAtSize('XLSX2PDF · 英汉对照', 9),
      y: y + 4,
      size: 9,
      font: regularFont,
      color: PALETTE.muted,
    })

    y -= 20
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: PAGE_WIDTH - MARGIN_X, y },
      thickness: 0.9,
      color: PALETTE.ink,
      opacity: 0.7,
    })

    y -= 21
    page.drawRectangle({
      x: MARGIN_X,
      y: y - 8,
      width: contentWidth,
      height: 24,
      color: PALETTE.pale,
    })

    let x = MARGIN_X + mm(2)
    if (showIndex) {
      drawText(page, '#', { x, y, size: 9.5, font: boldFont, color: PALETTE.muted })
      x += indexW + gap
    }
    drawText(page, 'English', { x, y, size: 9.5, font: boldFont, color: PALETTE.muted })
    x += englishW + gap
    drawText(page, '中文释义', { x, y, size: 9.5, font: boldFont, color: PALETTE.muted })
    y -= 22
  }

  const drawFooter = (targetPage, currentPageNumber) => {
    const footer = `Page ${currentPageNumber}`
    targetPage.drawLine({
      start: { x: MARGIN_X, y: MARGIN_BOTTOM + mm(4) },
      end: { x: PAGE_WIDTH - MARGIN_X, y: MARGIN_BOTTOM + mm(4) },
      thickness: 0.5,
      color: PALETTE.line,
    })
    drawText(targetPage, footer, {
      x: PAGE_WIDTH - MARGIN_X - regularFont.widthOfTextAtSize(footer, 8.5),
      y: MARGIN_BOTTOM,
      size: 8.5,
      font: regularFont,
      color: PALETTE.muted,
    })
  }

  addPage()

  rows.forEach((row) => {
    const englishLines = wrapText(row.english, Math.max(12, Math.floor(wrapChars * 0.9)))
    const chineseLines = wrapText(row.chinese, wrapChars)
    const rowHeight = Math.max(
      minRowHeight,
      (Math.max(englishLines.length, chineseLines.length) - 1) * rowLineHeight + 25,
    )

    if (y - rowHeight < bodyBottom) {
      drawFooter(page, pageNumber)
      addPage()
    }

    const rowTop = y
    page.drawLine({
      start: { x: MARGIN_X, y: rowTop + 7 },
      end: { x: PAGE_WIDTH - MARGIN_X, y: rowTop + 7 },
      thickness: 0.45,
      color: PALETTE.line,
    })

    let x = MARGIN_X + mm(2)
    if (showIndex) {
      drawText(page, String(row.index), {
        x,
        y: rowTop - 9,
        size: 9.5,
        font: regularFont,
        color: PALETTE.muted,
      })
      x += indexW + gap
    }

    drawWrapped(page, englishLines, x, rowTop - 9, {
      font: boldFont,
      size: 11.5,
      lineHeight: rowLineHeight,
      color: PALETTE.ink,
    })
    x += englishW + gap
    drawWrapped(page, chineseLines, x, rowTop - 9, {
      font: regularFont,
      size: 10.5,
      lineHeight: rowLineHeight,
      color: PALETTE.ink,
    })

    y -= rowHeight
  })

  if (!rows.length) {
    drawText(page, '没有可导出的词条。请检查起始行列设置。', {
      x: MARGIN_X,
      y: y - 12,
      size: 12,
      font: regularFont,
      color: PALETTE.muted,
    })
  }

  drawFooter(page, pageNumber)

  pdfDoc.setTitle(title)
  pdfDoc.setAuthor('XLSX2PDF Console')
  pdfDoc.setSubject('Generated from XLSX in browser')
  pdfDoc.setCreationDate(new Date())

  const pdfBytes = await pdfDoc.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}

export const downloadBlob = (blob, inputFileName = 'example.xlsx') => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = getSafeFileBase(inputFileName)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
