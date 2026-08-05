// These values are full-page capacities, not the number of populated rows on a
// particular export's final page. Later pages use the default capacity below.
const TEMPLATE_PAGE_CAPACITIES = [
  41, 41, 39, 39, 41, 41, 38, 40, 40, 39, 41, 38, 40, 37,
  40, 38, 41, 39, 40, 40, 38, 39, 39, 41, 38, 40, 37, 41,
  40, 40, 39, 39, 41, 40, 38, 37, 39, 41, 40, 39, 39, 41,
  38, 37, 40, 38, 39, 40, 40, 40, 37, 39, 39, 41, 37,
]

export const TEMPLATE_TITLE = '词表'
export const TEMPLATE_HEADERS = ['', '英文', '默写汉语', '中文', '默写英文']
export const TEMPLATE_DEFAULT_PAGE_CAPACITY = 40

export const TEMPLATE_PDF = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  tableX: 38.6,
  tableTop: 800.1,
  tableWidth: 501.0,
  headerHeight: 14.0,
  dataHeight: 738.9,
  footerY: 23.5,
  columns: [30, 124, 90, 149, 108],
  cellPaddingX: 4.4,
  gridInsetX: 2.2,
  gridInsetY: 1.2,
  gridRatio: 0.68,
}

export const getTemplatePageCapacity = (pageIndex) => {
  if (pageIndex < TEMPLATE_PAGE_CAPACITIES.length) return TEMPLATE_PAGE_CAPACITIES[pageIndex]
  return TEMPLATE_DEFAULT_PAGE_CAPACITY
}

export const paginateTemplateRows = (rows) => {
  const usableRows = Array.isArray(rows) ? rows : []
  const pages = []

  if (!usableRows.length) {
    return [{
      pageIndex: 1,
      startIndex: 1,
      endIndex: 0,
      capacity: getTemplatePageCapacity(0),
      rows: [],
    }]
  }

  let cursor = 0
  let pageIndex = 0
  while (cursor < usableRows.length) {
    const capacity = getTemplatePageCapacity(pageIndex)
    const pageRows = usableRows.slice(cursor, cursor + capacity)
    pages.push({
      pageIndex: pageIndex + 1,
      startIndex: cursor + 1,
      endIndex: cursor + pageRows.length,
      capacity,
      rows: pageRows,
    })
    cursor += capacity
    pageIndex += 1
  }
  return pages
}

const sanitizeExportBase = (value, fallback) => {
  const base = String(value || fallback || '词表')
    .replace(/\.[^.]+$/, '')
    .trim()
  return base || fallback || '词表'
}

export const getTemplateTitle = (inputFileName) => sanitizeExportBase(inputFileName, TEMPLATE_TITLE)
export const getTemplatePdfFileName = (inputFileName) => `${sanitizeExportBase(inputFileName, '词表')} 模板版.pdf`
export const getTemplateXlsxFileName = (inputFileName) => `${sanitizeExportBase(inputFileName, '词表')} 模板版.xlsx`
