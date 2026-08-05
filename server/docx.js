import { createZipBuffer } from './zip.js'

const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

const toTwips = (points) => Math.round(Number(points || 0) * 20)

const buildRunInnerXml = (text) => String(text ?? '')
  .split('\t')
  .map((part, index, array) => {
    const chunks = []
    if (part) chunks.push(`<w:t xml:space="preserve">${xmlEscape(part)}</w:t>`)
    if (index < array.length - 1) chunks.push('<w:tab/>')
    return chunks.join('')
  })
  .join('')

const buildRunXml = ({ text = '', bold = false, size = 12, font = '' }) => {
  const runProps = [
    bold ? '<w:b/>' : '',
    font ? `<w:rFonts w:ascii="${xmlEscape(font)}" w:hAnsi="${xmlEscape(font)}" w:cs="${xmlEscape(font)}"/>` : '',
    `<w:sz w:val="${Math.round(size * 2)}"/>`,
    `<w:szCs w:val="${Math.round(size * 2)}"/>`,
  ].join('')
  return `<w:r><w:rPr>${runProps}</w:rPr>${buildRunInnerXml(text)}</w:r>`
}

const buildParagraphXml = ({
  text = '',
  bold = false,
  size = 12,
  font = '',
  tabs = [],
  align = 'left',
  spaceBefore = 0,
  spaceAfter = 0,
  pageBreakBefore = false,
  keepNext = false,
  keepLines = false,
  indentLeft = 0,
}) => {
  const alignmentMap = {
    left: 'left',
    center: 'center',
    right: 'right',
    both: 'both',
  }
  const paragraphProps = [
    pageBreakBefore ? '<w:pageBreakBefore/>' : '',
    keepNext ? '<w:keepNext/>' : '',
    keepLines ? '<w:keepLines/>' : '',
    align ? `<w:jc w:val="${alignmentMap[align] || 'left'}"/>` : '',
    tabs.length ? `<w:tabs>${tabs.map((position) => `<w:tab w:val="left" w:pos="${toTwips(position)}"/>`).join('')}</w:tabs>` : '',
    indentLeft ? `<w:ind w:left="${toTwips(indentLeft)}"/>` : '',
    `<w:spacing w:before="${toTwips(spaceBefore)}" w:after="${toTwips(spaceAfter)}"/>`,
  ].join('')

  if (!text) {
    return `<w:p><w:pPr>${paragraphProps}</w:pPr></w:p>`
  }

  return `<w:p><w:pPr>${paragraphProps}</w:pPr>${buildRunXml({ text, bold, size, font })}</w:p>`
}

const buildTableCellXml = (cell = {}) => {
  const value = typeof cell === 'string' ? { text: cell } : (cell || {})
  const width = Math.max(120, Math.round(Number(value.widthTwips) || 2400))
  const paragraphXml = buildParagraphXml({
    text: value.text || '',
    bold: Boolean(value.bold),
    size: value.size || 12,
    font: value.font || '',
    align: value.align || 'left',
    spaceBefore: value.spaceBefore || 0,
    spaceAfter: value.spaceAfter || 0,
    keepNext: Boolean(value.keepNext),
    keepLines: Boolean(value.keepLines),
    tabs: value.tabs || [],
    indentLeft: value.indentLeft || 0,
  })
  return [
    '<w:tc>',
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`,
    value.noWrap ? '<w:noWrap/>' : '',
    '<w:tcBorders>',
    '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>',
    '</w:tcBorders>',
    '</w:tcPr>',
    paragraphXml,
    '</w:tc>',
  ].join('')
}

const buildTableXml = ({
  rows = [],
  columnWidths = [],
  cantSplit = false,
  fixedLayout = false,
  cellMargins = {},
}) => {
  const safeColumnWidths = (columnWidths.length ? columnWidths : [2800, 3600]).map((value) => Math.max(120, Math.round(Number(value) || 2400)))
  const totalWidth = safeColumnWidths.reduce((sum, value) => sum + value, 0)
  const normalizeMargin = (value, fallback) => (
    value == null ? fallback : Math.max(0, Math.round(Number(value) || 0))
  )
  const safeCellMargins = {
    top: normalizeMargin(cellMargins.top, 24),
    right: normalizeMargin(cellMargins.right, 36),
    bottom: normalizeMargin(cellMargins.bottom, 24),
    left: normalizeMargin(cellMargins.left, 36),
  }
  const gridXml = safeColumnWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')
  const rowsXml = rows.map((row) => {
    const cells = Array.isArray(row) ? row : []
    const cellXml = safeColumnWidths.map((width, index) => buildTableCellXml({
      ...(typeof cells[index] === 'string' ? { text: cells[index] } : (cells[index] || {})),
      widthTwips: width,
    })).join('')
    return `<w:tr>${cantSplit ? '<w:trPr><w:cantSplit/></w:trPr>' : ''}${cellXml}</w:tr>`
  }).join('')

  return [
    '<w:tbl>',
    '<w:tblPr>',
    '<w:tblStyle w:val="TableGrid"/>',
    `<w:tblW w:w="${totalWidth}" w:type="dxa"/>`,
    fixedLayout ? '<w:tblLayout w:type="fixed"/>' : '',
    '<w:tblBorders>',
    '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>',
    '<w:insideH w:val="nil"/><w:insideV w:val="nil"/>',
    '</w:tblBorders>',
    '<w:tblCellMar>',
    `<w:top w:w="${safeCellMargins.top}" w:type="dxa"/><w:left w:w="${safeCellMargins.left}" w:type="dxa"/><w:bottom w:w="${safeCellMargins.bottom}" w:type="dxa"/><w:right w:w="${safeCellMargins.right}" w:type="dxa"/>`,
    '</w:tblCellMar>',
    '</w:tblPr>',
    `<w:tblGrid>${gridXml}</w:tblGrid>`,
    rowsXml,
    '</w:tbl>',
  ].join('')
}

const buildSectionPropertiesXml = ({ columns = 1, columnSpacing = 18 } = {}) => {
  const safeColumns = Math.max(1, Math.min(4, Math.round(Number(columns) || 1)))
  return [
    '<w:sectPr>',
    '<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>',
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>',
    `<w:cols w:num="${safeColumns}" w:space="${toTwips(columnSpacing)}"/>`,
    '</w:sectPr>',
  ].join('')
}

const buildBlockXml = (block) => {
  if (block?.kind === 'table') return buildTableXml(block)
  return buildParagraphXml(block || {})
}

const createStylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>`

const createDocumentXml = (blocks, sectionOptions = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 wp14">
  <w:body>
    ${blocks.map(buildBlockXml).join('')}
    ${buildSectionPropertiesXml(sectionOptions)}
  </w:body>
</w:document>`

const createContentTypesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const createRootRelsXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const createDocumentRelsXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>
</Relationships>`

const createCoreXml = (title) => {
  const created = new Date().toISOString()
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>XLSX2PDF Console</dc:creator>
  <cp:lastModifiedBy>XLSX2PDF Console</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`
}

const createAppXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties
  xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>XLSX2PDF Console</Application>
</Properties>`

export const createDocxBuffer = ({ title, paragraphs, columns = 1, columnSpacing = 18 }) => {
  return createZipBuffer([
    { name: '[Content_Types].xml', data: createContentTypesXml() },
    { name: '_rels/.rels', data: createRootRelsXml() },
    { name: 'docProps/core.xml', data: createCoreXml(title) },
    { name: 'docProps/app.xml', data: createAppXml() },
    { name: 'word/document.xml', data: createDocumentXml(paragraphs, { columns, columnSpacing }) },
    { name: 'word/styles.xml', data: createStylesXml() },
    { name: 'word/_rels/document.xml.rels', data: createDocumentRelsXml() },
    { name: 'word/settings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>` },
    { name: 'word/webSettings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>` },
  ])
}
