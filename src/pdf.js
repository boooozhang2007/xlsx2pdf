import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { DEFAULT_CONFIG, MAX_ROWS_PER_PAGE, clampInt, paginateRows } from './utils'

const MM_TO_PT = 72 / 25.4
const mm = (value) => value * MM_TO_PT

const PAGE_WIDTH = mm(210)
const PAGE_HEIGHT = mm(297)

// Mirrors the concrete worksheet geometry in example.pdf while keeping the
// text fitting and four-line-grid logic from core/core.py.
export const TEMPLATE = {
  pageWidth: PAGE_WIDTH,
  pageHeight: PAGE_HEIGHT,
  tableWidth: mm(190),
  topMargin: mm(9),
  headerHeight: mm(7.4),
  rowHeight: mm(8.8),
  bodyHeight: mm(8.8 * DEFAULT_CONFIG.rowsPerPage),
  pageNumberY: mm(7.2),
  lineWidth: 0.5,
}

TEMPLATE.left = (PAGE_WIDTH - TEMPLATE.tableWidth) / 2
TEMPLATE.columns = [
  mm(9),
  mm(40),
  mm(31),
  mm(48),
  mm(62),
]
TEMPLATE.headers = ['序号', '英文', '默写汉语', '中文', '默写英文']

const BLACK = rgb(0, 0, 0)
const hasNonWinAnsiChars = (value) => /[^\u0000-\u00ff]/.test(String(value ?? ''))

const getSafeFileBase = (name = 'example.xlsx') => {
  const base = name.replace(/\.[^.]+$/, '') || 'example'
  return `${base}.pdf`
}

const normalizeRowsPerPage = (value) =>
  clampInt(value, 1, MAX_ROWS_PER_PAGE, DEFAULT_CONFIG.rowsPerPage)

const getTemplateMetrics = (rowsPerPage) => ({
  rowHeight: TEMPLATE.bodyHeight / rowsPerPage,
  tableHeight: TEMPLATE.headerHeight + TEMPLATE.bodyHeight,
})

const textLength = (value) => [...String(value ?? '')].length

const tokenize = (text) => {
  const rawText = String(text ?? '')
  if (!rawText) return []

  // Keep the same tokenization strategy as core/core.py:
  // CJK text wraps by individual Han characters while latin/number/symbol runs
  // stay together; English phrases prefer breaking at spaces.
  if (/[\u4e00-\u9fff]/.test(rawText)) {
    const rawTokens = rawText.match(/[A-Za-z0-9./&()-]+|[\u4e00-\u9fff]|[^A-Za-z0-9\u4e00-\u9fff]/g) || []
    const tokens = []
    let prevSpace = false
    rawTokens.forEach((token) => {
      if (/^\s+$/.test(token)) {
        if (!prevSpace) tokens.push(' ')
        prevSpace = true
      } else {
        tokens.push(token)
        prevSpace = false
      }
    })
    return tokens
  }

  const parts = rawText.split(' ')
  const tokens = []
  parts.forEach((part, index) => {
    if (index) tokens.push(' ')
    tokens.push(part)
  })
  return tokens
}

const wrapTextByWidth = (text, width, font, size, maxLines = 2, maxChars = Infinity) => {
  const raw = String(text ?? '')
  if (!raw) return []

  const lines = []
  let current = ''
  const hasMaxChars = Number.isFinite(maxChars) && maxChars > 0

  for (const token of tokenize(raw)) {
    const candidate = current + token
    const withinWidth = font.widthOfTextAtSize(candidate, size) <= width
    const withinChars = !hasMaxChars || textLength(candidate.trim()) <= maxChars

    if ((withinWidth && withinChars) || !current) {
      current = candidate
    } else {
      const line = current.trim()
      if (line) lines.push(line)
      current = token === ' ' ? '' : token.trim()
      if (lines.length >= maxLines) break
    }
  }

  if (current && lines.length < maxLines) lines.push(current.trim())
  return lines.slice(0, maxLines).filter(Boolean)
}

const fitLines = (text, width, font, startSize, minSize = 5.8, maxLines = 3, maxChars = Infinity) => {
  let size = startSize

  while (size >= minSize) {
    const lines = wrapTextByWidth(text, width, font, size, maxLines, maxChars)
    if (!lines.length || Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size))) <= width) {
      return { lines, size }
    }
    size -= 0.3
  }

  return {
    lines: wrapTextByWidth(text, width, font, minSize, maxLines, maxChars),
    size: minSize,
  }
}

const drawTextCentered = (page, text, x, y, w, h, font, size, options = {}) => {
  const {
    maxLines = 2,
    minSize = 6,
    wrapChars = Infinity,
    lineHeightRatio = 1.15,
    padding = mm(1),
  } = options
  const raw = String(text ?? '').trim()
  if (!raw) return

  const maxWidth = Math.max(1, w - padding * 2)
  const { lines, size: actualSize } = fitLines(raw, maxWidth, font, size, minSize, maxLines, wrapChars)
  if (!lines.length) return

  const leading = actualSize * lineHeightRatio
  const totalHeight = leading * lines.length
  const firstBaseline = y + (h + totalHeight) / 2 - actualSize

  lines.forEach((line, index) => {
    const lineWidth = font.widthOfTextAtSize(line, actualSize)
    page.drawText(line, {
      x: x + (w - lineWidth) / 2,
      y: firstBaseline - index * leading,
      size: actualSize,
      font,
      color: BLACK,
    })
  })
}

const drawFourlineGrid = (page, gridImage, x, y, w, h) => {
  const drawW = w - 2 * mm(1)
  const drawH = Math.min(mm(6), h * (6 / 8.8))
  page.drawImage(gridImage, {
    x: x + mm(1),
    y: y + (h - drawH) / 2,
    width: drawW,
    height: drawH,
  })
}

const drawTemplatePage = (page, {
  rows,
  pageNumber,
  rowsPerPage,
  cjkFont,
  enFont,
  gridImage,
  wrapChars,
}) => {
  const tableX = TEMPLATE.left
  const tableTop = PAGE_HEIGHT - TEMPLATE.topMargin
  const yHeader = tableTop - TEMPLATE.headerHeight
  const { rowHeight, tableHeight } = getTemplateMetrics(rowsPerPage)
  const tableBottom = tableTop - tableHeight
  const xs = [tableX]
  TEMPLATE.columns.forEach((width) => xs.push(xs.at(-1) + width))

  xs.forEach((x) => {
    page.drawLine({
      start: { x, y: tableBottom },
      end: { x, y: tableTop },
      thickness: TEMPLATE.lineWidth,
      color: BLACK,
    })
  })

  page.drawLine({
    start: { x: tableX, y: tableTop },
    end: { x: tableX + TEMPLATE.tableWidth, y: tableTop },
    thickness: TEMPLATE.lineWidth,
    color: BLACK,
  })
  page.drawLine({
    start: { x: tableX, y: yHeader },
    end: { x: tableX + TEMPLATE.tableWidth, y: yHeader },
    thickness: TEMPLATE.lineWidth,
    color: BLACK,
  })

  for (let index = 0; index <= rowsPerPage; index += 1) {
    const y = yHeader - index * rowHeight
    page.drawLine({
      start: { x: tableX, y },
      end: { x: tableX + TEMPLATE.tableWidth, y },
      thickness: TEMPLATE.lineWidth,
      color: BLACK,
    })
  }

  TEMPLATE.headers.forEach((header, index) => {
    const size = 9.2
    const width = cjkFont.widthOfTextAtSize(header, size)
    page.drawText(header, {
      x: xs[index] + (TEMPLATE.columns[index] - width) / 2,
      y: yHeader + (TEMPLATE.headerHeight - size) / 2 + 1.2,
      size,
      font: cjkFont,
      color: BLACK,
    })
  })

  for (let rowIndex = 0; rowIndex < rowsPerPage; rowIndex += 1) {
    const yTop = yHeader - rowIndex * rowHeight
    const y = yTop - rowHeight
    drawFourlineGrid(page, gridImage, xs[4], y, TEMPLATE.columns[4], rowHeight)
  }

  rows.forEach((row, rowIndex) => {
    const yTop = yHeader - rowIndex * rowHeight
    const y = yTop - rowHeight

    const rowFontScale = Math.min(1, rowHeight / TEMPLATE.rowHeight)
    const englishFont = hasNonWinAnsiChars(row.english) ? cjkFont : enFont
    drawTextCentered(page, row.index, xs[0], y, TEMPLATE.columns[0], rowHeight, enFont, 8.3 * rowFontScale, {
      maxLines: 1,
      minSize: Math.min(6.4, 6.4 * rowFontScale),
      wrapChars: Infinity,
    })
    drawTextCentered(page, row.english, xs[1], y, TEMPLATE.columns[1], rowHeight, englishFont, 9.3 * rowFontScale, {
      maxLines: 2,
      minSize: Math.min(6.4, 6.4 * rowFontScale),
      wrapChars,
    })
    drawTextCentered(page, row.chinese, xs[3], y, TEMPLATE.columns[3], rowHeight, cjkFont, 8.8 * rowFontScale, {
      maxLines: 3,
      minSize: Math.min(5.7, 5.7 * rowFontScale),
      wrapChars,
    })
  })

  const pageText = String(pageNumber)
  const pageTextSize = 7.5
  page.drawText(pageText, {
    x: PAGE_WIDTH / 2 - enFont.widthOfTextAtSize(pageText, pageTextSize) / 2,
    y: TEMPLATE.pageNumberY,
    size: pageTextSize,
    font: enFont,
    color: BLACK,
  })
}

export const createPdfFromRows = async (rows, config, inputFileName = 'example.xlsx') => {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)

  const [cjkBytes, gridBytes] = await Promise.all([
    fetch('/STSong.ttf').then((res) => res.arrayBuffer()),
    fetch('/fourline.png').then((res) => res.arrayBuffer()),
  ])

  const cjkFont = await pdfDoc.embedFont(cjkBytes, { subset: true })
  const enFont = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const gridImage = await pdfDoc.embedPng(gridBytes)

  const rowsPerPage = normalizeRowsPerPage(config.rowsPerPage)
  const pages = paginateRows(rows, rowsPerPage)
  const wrapChars = Number(config.wrapChars) || 26

  pages.forEach((pageRows, pageIndex) => {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    drawTemplatePage(page, {
      rows: pageRows,
      pageNumber: pageIndex + 1,
      rowsPerPage,
      cjkFont,
      enFont,
      gridImage,
      wrapChars,
    })
  })

  pdfDoc.setTitle(config.title?.trim() || getSafeFileBase(inputFileName).replace(/\.pdf$/i, ''))
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
