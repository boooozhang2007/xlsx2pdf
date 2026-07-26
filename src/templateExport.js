import { TEMPLATE_HEADERS, TEMPLATE_PDF, getTemplateXlsxFileName, paginateTemplateRows } from './templateLayout.js'

const TEMPLATE_WORKBOOK_URL = '/template-worksheet.xlsx'
const TEMPLATE_PRINT_SCALE = 0.82

let excelJsModulePromise = null
let templateWorkbookBytesPromise = null

const cloneStyle = (style) => {
  if (!style) return {}
  return JSON.parse(JSON.stringify(style))
}

const loadExcelJs = async () => {
  if (!excelJsModulePromise) excelJsModulePromise = import('exceljs')
  return excelJsModulePromise
}

const loadTemplateWorkbookBytes = async () => {
  if (!templateWorkbookBytesPromise) {
    templateWorkbookBytesPromise = fetch(TEMPLATE_WORKBOOK_URL).then(async (response) => {
      if (!response.ok) throw new Error('无法读取模板 XLSX 文件。')
      return response.arrayBuffer()
    })
  }
  return templateWorkbookBytesPromise
}

const createWorkbookFromTemplate = async () => {
  const [{ default: ExcelJS }, templateBytes] = await Promise.all([
    loadExcelJs(),
    loadTemplateWorkbookBytes(),
  ])
  const templateWorkbook = new ExcelJS.Workbook()
  await templateWorkbook.xlsx.load(templateBytes.slice(0))
  return { ExcelJS, templateWorkbook }
}

const buildPageSetup = (sourcePageSetup, rowCount) => ({
  paperSize: sourcePageSetup?.paperSize || 9,
  orientation: sourcePageSetup?.orientation || 'portrait',
  scale: Number(sourcePageSetup?.scale) || 82,
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 1,
  horizontalCentered: Boolean(sourcePageSetup?.horizontalCentered),
  verticalCentered: Boolean(sourcePageSetup?.verticalCentered),
  margins: {
    left: Number(sourcePageSetup?.margins?.left) || 0.55,
    right: Number(sourcePageSetup?.margins?.right) || 0.63,
    top: Number(sourcePageSetup?.margins?.top) || 0.59,
    bottom: Number(sourcePageSetup?.margins?.bottom) || 0.59,
    header: Number(sourcePageSetup?.margins?.header) || 0.39,
    footer: Number(sourcePageSetup?.margins?.footer) || 0.39,
  },
  printTitlesRow: '1:1',
  printArea: `A1:E${Math.max(1, rowCount)}`,
})

const copyCell = (targetCell, sourceCell, value) => {
  targetCell.style = cloneStyle(sourceCell.style)
  targetCell.value = value
}

const getDataRowHeightPt = (capacity) => {
  return Math.round(((TEMPLATE_PDF.dataHeight / capacity) / TEMPLATE_PRINT_SCALE) * 10) / 10
}

export const createTemplateXlsxBlob = async (rows, inputFileName = 'example.xlsx') => {
  const { ExcelJS, templateWorkbook } = await createWorkbookFromTemplate()
  const sourceSheet = templateWorkbook.worksheets[0]
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'XLSX2PDF'
  workbook.lastModifiedBy = 'XLSX2PDF'
  workbook.created = new Date()
  workbook.modified = new Date()

  const worksheet = workbook.addWorksheet(sourceSheet.name || 'Sheet2', {
    views: sourceSheet.views,
    properties: {
      defaultRowHeight: sourceSheet.properties?.defaultRowHeight || 20.4,
    },
    pageSetup: buildPageSetup(sourceSheet.pageSetup, (rows?.length || 0) + 1),
  })
  worksheet.pageSetup.printTitlesRow = '1:1'
  worksheet.pageSetup.printArea = `A1:E${Math.max(1, (rows?.length || 0) + 1)}`

  ;[1, 2, 3, 4, 5].forEach((columnIndex) => {
    worksheet.getColumn(columnIndex).width = sourceSheet.getColumn(columnIndex).width
  })

  copyCell(worksheet.getCell('A1'), sourceSheet.getCell('A2'), null)
  copyCell(worksheet.getCell('B1'), sourceSheet.getCell('B1'), TEMPLATE_HEADERS[1])
  copyCell(worksheet.getCell('C1'), sourceSheet.getCell('C1'), TEMPLATE_HEADERS[2])
  copyCell(worksheet.getCell('D1'), sourceSheet.getCell('D1'), TEMPLATE_HEADERS[3])
  copyCell(worksheet.getCell('E1'), sourceSheet.getCell('E1'), TEMPLATE_HEADERS[4])
  worksheet.getRow(1).height = sourceSheet.getRow(1).height || 15

  const indexStyleCell = sourceSheet.getCell('A2')
  const englishStyleCell = sourceSheet.getCell('B4')
  const blankStyleCell = sourceSheet.getCell('C4')
  const chineseStyleCell = sourceSheet.getCell('D4')
  const writeStyleCell = sourceSheet.getCell('E2')

  let excelRow = 2
  paginateTemplateRows(rows || []).forEach((pageData) => {
    pageData.rows.forEach((row, rowIndex) => {
      const serial = pageData.startIndex + rowIndex
      copyCell(worksheet.getCell(`A${excelRow}`), indexStyleCell, serial)
      copyCell(worksheet.getCell(`B${excelRow}`), englishStyleCell, String(row?.english || '').trim())
      copyCell(worksheet.getCell(`C${excelRow}`), blankStyleCell, null)
      copyCell(worksheet.getCell(`D${excelRow}`), chineseStyleCell, String(row?.chinese || '').trim())
      copyCell(worksheet.getCell(`E${excelRow}`), writeStyleCell, null)
      worksheet.getRow(excelRow).height = getDataRowHeightPt(pageData.capacity)
      excelRow += 1
    })
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export const getTemplateWorkbookDownloadName = getTemplateXlsxFileName
