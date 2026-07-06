import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { TEMPLATE_HEADERS, TEMPLATE_PDF, getTemplatePdfFileName, getTemplateTitle, paginateTemplateRows } from './templateLayout.js'

const BLACK = rgb(0, 0, 0)
const YELLOW = rgb(1, 0.96, 0)

let cjkFontBytesPromise = null

const hasNonWinAnsiChars = (value) => /[^\u0000-\u00ff]/.test(String(value ?? ''))

const loadTemplateAssets = async () => {
  if (!cjkFontBytesPromise) {
    cjkFontBytesPromise = fetch('/STSong.ttf').then(async (response) => {
      if (!response.ok) throw new Error('无法读取 STSong.ttf')
      return response.arrayBuffer()
    })
  }
  return Promise.all([cjkFontBytesPromise])
}

const tokenize = (text) => {
  const raw = String(text ?? '')
  if (!raw) return []

  if (/[\u4e00-\u9fff]/.test(raw)) {
    const rawTokens = raw.match(/[A-Za-z0-9./&()'’:-]+|[\u4e00-\u9fff]|[^A-Za-z0-9\u4e00-\u9fff]/g) || []
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

  const parts = raw.split(' ')
  const tokens = []
  parts.forEach((part, index) => {
    if (index) tokens.push(' ')
    tokens.push(part)
  })
  return tokens
}

const wrapTextByWidth = (text, width, font, size, maxLines = 2) => {
  const raw = String(text ?? '')
  if (!raw) return []

  const lines = []
  let current = ''
  for (const token of tokenize(raw)) {
    const candidate = current + token
    const withinWidth = font.widthOfTextAtSize(candidate, size) <= width

    if (withinWidth || !current) {
      current = candidate
      continue
    }

    const line = current.trim()
    if (line) lines.push(line)
    current = token === ' ' ? '' : token.trim()
    if (lines.length >= maxLines) break
  }

  if (current && lines.length < maxLines) lines.push(current.trim())
  return lines.slice(0, maxLines).filter(Boolean)
}

const fitLines = (
  text,
  width,
  font,
  startSize,
  minSize = 6.8,
  maxLines = 3,
  maxHeight = Infinity,
  lineHeightRatio = 1.12,
) => {
  let size = startSize

  while (size >= minSize) {
    const lines = wrapTextByWidth(text, width, font, size, maxLines)
    const fitsWidth = !lines.length || Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size))) <= width
    const fitsHeight = lines.length * size * lineHeightRatio <= maxHeight
    if (fitsWidth && fitsHeight) return { lines, size }
    size -= 0.25
  }

  return {
    lines: wrapTextByWidth(text, width, font, minSize, maxLines),
    size: minSize,
  }
}

const drawCellText = (page, text, x, y, width, height, font, size, options = {}) => {
  const {
    align = 'left',
    maxLines = 2,
    minSize = 6.8,
    lineHeightRatio = 1.12,
    paddingX = TEMPLATE_PDF.cellPaddingX,
    paddingY = 1.4,
  } = options
  const raw = String(text ?? '').trim()
  if (!raw) return

  const usableWidth = Math.max(1, width - paddingX * 2)
  const usableHeight = Math.max(1, height - paddingY * 2)
  const { lines, size: actualSize } = fitLines(raw, usableWidth, font, size, minSize, maxLines, usableHeight, lineHeightRatio)
  if (!lines.length) return

  const lineHeight = actualSize * lineHeightRatio
  const totalHeight = lines.length * lineHeight
  let baselineY = y + (height + totalHeight) / 2 - actualSize
  if (lines.length > 1 && height > totalHeight + paddingY * 2 + 2) baselineY += 0.6

  lines.forEach((line, index) => {
    const lineWidth = font.widthOfTextAtSize(line, actualSize)
    let drawX = x + paddingX
    if (align === 'center') drawX = x + (width - lineWidth) / 2
    if (align === 'right') drawX = x + width - paddingX - lineWidth
    page.drawText(line, {
      x: drawX,
      y: baselineY - index * lineHeight,
      size: actualSize,
      font,
      color: BLACK,
    })
  })
}

const buildColumnXs = () => {
  const xs = [TEMPLATE_PDF.tableX]
  TEMPLATE_PDF.columns.forEach((width) => xs.push(xs.at(-1) + width))
  return xs
}

const drawPageFrame = (page, capacity, fonts, pageNumber, totalPages, titleText) => {
  const xs = buildColumnXs()
  const tableTop = TEMPLATE_PDF.tableTop
  const titleBottom = tableTop - TEMPLATE_PDF.titleHeight
  const headerBottom = titleBottom - TEMPLATE_PDF.headerHeight
  const rowHeight = TEMPLATE_PDF.dataHeight / capacity
  const tableBottom = headerBottom - rowHeight * capacity

  for (let index = 1; index < xs.length; index += 1) {
    page.drawRectangle({
      x: xs[index - 1],
      y: titleBottom,
      width: xs[index] - xs[index - 1],
      height: TEMPLATE_PDF.titleHeight,
      color: index === 1 ? rgb(1, 1, 1) : YELLOW,
    })
  }

  xs.forEach((x) => {
    page.drawLine({
      start: { x, y: tableBottom },
      end: { x, y: tableTop },
      thickness: 1,
      color: BLACK,
    })
  })

  ;[tableTop, titleBottom, headerBottom].forEach((y) => {
    page.drawLine({
      start: { x: xs[0], y },
      end: { x: xs.at(-1), y },
      thickness: 1,
      color: BLACK,
    })
  })

  for (let rowIndex = 0; rowIndex <= capacity; rowIndex += 1) {
    const y = headerBottom - rowHeight * rowIndex
    page.drawLine({
      start: { x: xs[0], y },
      end: { x: xs.at(-1), y },
      thickness: 1,
      color: BLACK,
    })
  }

  drawCellText(
    page,
    titleText,
    xs[1],
    titleBottom,
    xs.at(-1) - xs[1],
    TEMPLATE_PDF.titleHeight,
    fonts.cjk,
    12.8,
    {
      align: 'left',
      maxLines: 1,
      minSize: 7.2,
      paddingX: TEMPLATE_PDF.titlePaddingX,
      paddingY: 1,
    },
  )

  TEMPLATE_HEADERS.forEach((header, index) => {
    if (!header) return
    drawCellText(
      page,
      header,
      xs[index],
      titleBottom - TEMPLATE_PDF.headerHeight,
      TEMPLATE_PDF.columns[index],
      TEMPLATE_PDF.headerHeight,
      fonts.cjk,
      11.2,
      {
        align: 'center',
        maxLines: 1,
        minSize: 9.6,
        paddingX: 2,
        paddingY: 1,
      },
    )
  })

  const footer = `第 ${pageNumber} 页，共 ${totalPages} 页`
  const footerWidth = fonts.cjk.widthOfTextAtSize(footer, 10.2)
  page.drawText(footer, {
    x: (TEMPLATE_PDF.pageWidth - footerWidth) / 2,
    y: TEMPLATE_PDF.footerY,
    size: 10.2,
    font: fonts.cjk,
    color: BLACK,
  })

  return {
    xs,
    rowHeight,
    rowsTop: headerBottom,
  }
}

export const createTemplatePdfFromRows = async (rows, inputFileName = 'example.xlsx') => {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)
  const templateTitle = getTemplateTitle(inputFileName)

  const [cjkBytes] = await loadTemplateAssets()
  const cjk = await pdfDoc.embedFont(cjkBytes, { subset: true })
  const sans = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const serif = await pdfDoc.embedFont(StandardFonts.TimesRoman)

  const pages = paginateTemplateRows(rows)
  pages.forEach((pageData, pageIndex) => {
    const page = pdfDoc.addPage([TEMPLATE_PDF.pageWidth, TEMPLATE_PDF.pageHeight])
    const layout = drawPageFrame(page, pageData.capacity, { cjk }, pageIndex + 1, pages.length, templateTitle)

    pageData.rows.forEach((row, rowIndex) => {
      const rowBottom = layout.rowsTop - layout.rowHeight * (rowIndex + 1)
      const englishFont = hasNonWinAnsiChars(row?.english) ? cjk : sans

      drawCellText(page, pageData.startIndex + rowIndex, layout.xs[0], rowBottom, TEMPLATE_PDF.columns[0], layout.rowHeight, serif, 10.4, {
        align: 'center',
        maxLines: 1,
        minSize: 8.4,
        paddingX: 2,
      })

      drawCellText(page, row?.english || '', layout.xs[1], rowBottom, TEMPLATE_PDF.columns[1], layout.rowHeight, englishFont, 10.8, {
        align: 'left',
        maxLines: 2,
        minSize: 7.4,
      })

      drawCellText(page, row?.chinese || '', layout.xs[3], rowBottom, TEMPLATE_PDF.columns[3], layout.rowHeight, cjk, 10.6, {
        align: 'left',
        maxLines: 3,
        minSize: 7.2,
      })
    })
  })

  pdfDoc.setTitle(templateTitle)
  pdfDoc.setAuthor('XLSX2PDF')
  pdfDoc.setSubject('Template worksheet export')
  pdfDoc.setCreationDate(new Date())

  const pdfBytes = await pdfDoc.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}

export const downloadTemplatePdfBlob = (blob, inputFileName = 'example.xlsx') => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = getTemplatePdfFileName(inputFileName)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
