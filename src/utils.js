// xlsx2pdf application constants and pure helpers.

export const DEFAULT_CONFIG = {
  sheetName: '',
  englishRow: 3,
  englishCol: 2,
  chineseRow: 3,
  chineseCol: 4,
  wrapChars: 26,
  maxRows: 160,
  title: '英汉词表',
  showIndex: true,
}

export const SAMPLE_ROWS = [
  { index: 1, english: 'cheat', chinese: 'v. 欺骗；作弊 n. 骗子' },
  { index: 2, english: 'share', chinese: 'vt. 分享；共用；分配' },
  { index: 3, english: 'pay phone', chinese: '付费电话' },
  { index: 4, english: 'energy', chinese: 'n. 精力；能量' },
  { index: 5, english: 'master', chinese: 'n. 主人；能手 v. 掌握' },
  { index: 6, english: 'hardly ever', chinese: '几乎从不；很少' },
]

export const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const columnToLetter = (columnNumber) => {
  let n = Math.max(1, Number(columnNumber) || 1)
  let letters = ''
  while (n > 0) {
    const mod = (n - 1) % 26
    letters = String.fromCharCode(65 + mod) + letters
    n = Math.floor((n - mod) / 26)
  }
  return letters
}

export const cellAddress = (row, col) => `${columnToLetter(col)}${row}`

export const stringifyCell = (value) => {
  if (value == null) return ''
  if (value instanceof Date) return value.toLocaleDateString('zh-CN')
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export const wrapText = (text, maxChars = 26) => {
  const normalized = stringifyCell(text)
  const limit = Math.max(4, Number(maxChars) || 26)
  if (!normalized) return ['']

  const paragraphs = normalized.split(/\r?\n/)
  const lines = []

  paragraphs.forEach((paragraph) => {
    let current = ''
    const tokens = paragraph.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*|\s+|[^\s]/g) || []

    tokens.forEach((token) => {
      if (/^\s+$/.test(token)) {
        if (current && !current.endsWith(' ')) current += ' '
        return
      }

      const next = current ? current + token : token
      if ([...next].length <= limit) {
        current = next
        return
      }

      if (current.trim()) lines.push(current.trim())

      if ([...token].length > limit) {
        let chunk = ''
        for (const char of token) {
          if ([...chunk, char].length > limit) {
            lines.push(chunk)
            chunk = char
          } else {
            chunk += char
          }
        }
        current = chunk
      } else {
        current = token
      }
    })

    if (current.trim()) lines.push(current.trim())
    if (!paragraph.trim()) lines.push('')
  })

  return lines.length ? lines : ['']
}

export const extractPairsFromSheet = (worksheet, config) => {
  if (!worksheet) return []

  const range = worksheet['!ref']
  if (!range) return []

  const englishStartRow = clampInt(config.englishRow, 1, 100000, DEFAULT_CONFIG.englishRow)
  const chineseStartRow = clampInt(config.chineseRow, 1, 100000, DEFAULT_CONFIG.chineseRow)
  const englishCol = clampInt(config.englishCol, 1, 500, DEFAULT_CONFIG.englishCol)
  const chineseCol = clampInt(config.chineseCol, 1, 500, DEFAULT_CONFIG.chineseCol)
  const maxRows = clampInt(config.maxRows, 1, 2000, DEFAULT_CONFIG.maxRows)

  const decodedRange = window.XLSX?.utils?.decode_range
    ? window.XLSX.utils.decode_range(range)
    : null

  const endRowFromRange = decodedRange ? decodedRange.e.r + 1 : Math.max(englishStartRow, chineseStartRow)
  const startRow = Math.min(englishStartRow, chineseStartRow)
  const endRow = Math.min(endRowFromRange, startRow + maxRows - 1)

  const rows = []
  for (let row = startRow; row <= endRow; row += 1) {
    const englishCell = `${columnToLetter(englishCol)}${row + (englishStartRow - startRow)}`
    const chineseCell = `${columnToLetter(chineseCol)}${row + (chineseStartRow - startRow)}`
    const english = stringifyCell(worksheet[englishCell]?.v ?? worksheet[englishCell]?.w)
    const chinese = stringifyCell(worksheet[chineseCell]?.v ?? worksheet[chineseCell]?.w)

    if (!english && !chinese) continue

    rows.push({
      index: rows.length + 1,
      sourceRow: row,
      englishCell,
      chineseCell,
      english,
      chinese,
    })
  }

  return rows
}
