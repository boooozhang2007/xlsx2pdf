import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  ArrowDownToLine,
  Columns3,
  FileSpreadsheet,
  FileText,
  Headphones,
  Loader2,
  Rows3,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
} from 'lucide-react'
import {
  DEFAULT_CONFIG,
  MAX_ROWS_PER_PAGE,
  SAMPLE_ROWS,
  cellAddress,
  clampInt,
  columnToLetter,
  extractPairsFromSheet,
  paginateRows,
} from './utils'
import { createPdfFromRows, downloadBlob } from './pdf'
import { downloadNamedBlob } from './ttsUtils'
import MobileListenPage from './MobileListenPage'
import TtsWorkspace from './TtsWorkspace'
import GenWorkspace from './GenWorkspace'
import { createTemplateXlsxBlob, getTemplateWorkbookDownloadName } from './templateExport'
import { createTemplatePdfFromRows, downloadTemplatePdfBlob } from './templatePdf'
import './styles.css'

window.XLSX = XLSX

const readFileAsArrayBuffer = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })

const InputField = ({ label, value, onChange, min = 1, max = 999, suffix, icon: Icon }) => (
  <label className="field">
    <span>
      {Icon ? <Icon size={15} /> : null}
      {label}
    </span>
    <div className="inputShell">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clampInt(event.target.value, min, max, value))}
      />
      {suffix ? <em>{suffix}</em> : null}
    </div>
  </label>
)

const Pill = ({ children, tone = 'neutral' }) => <span className={`pill pill-${tone}`}>{children}</span>

const UploadActions = ({ isLoading, onUpload, onUseExample }) => (
  <>
    <button className="primaryButton" type="button" onClick={onUpload} disabled={isLoading}>
      <UploadCloud size={18} /> 上传 XLSX
    </button>
    <button className="ghostButton" type="button" onClick={onUseExample} disabled={isLoading}>
      {isLoading ? <Loader2 className="spin" size={17} /> : <FileSpreadsheet size={17} />}
      使用 example.xlsx
    </button>
  </>
)

const TemplateRow = ({ row = {}, empty = false, showPracticeGrid = false }) => (
  <>
    <div className="templateCell indexCell">
      {empty ? null : <span className="templateCellFit">{row.index}</span>}
    </div>
    <div className="templateCell englishCell">
      {empty ? null : <span className="templateCellFit">{row.english || '—'}</span>}
    </div>
    <div className="templateCell writeChineseCell" />
    <div className="templateCell chineseCell" title={empty ? '' : row.chinese || ''}>
      {empty ? null : <span className="templateCellFit">{row.chinese || '—'}</span>}
    </div>
    <div className="templateCell writeEnglishCell">
      {showPracticeGrid ? <img src="/fourline.png" alt="" /> : null}
    </div>
  </>
)

const getToolFromPath = (pathname) => {
  if (pathname.startsWith('/tts')) return 'tts'
  if (pathname.startsWith('/gen')) return 'gen'
  return 'pdf'
}

const getToolPath = (tool) => {
  if (tool === 'tts') return '/tts'
  if (tool === 'gen') return '/gen'
  return '/'
}

function App() {
  const [workbook, setWorkbook] = useState(null)
  const [fileName, setFileName] = useState('example.xlsx')
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [status, setStatus] = useState('已内置 example.xlsx，可直接预览或重新上传文件。')
  const [isLoading, setIsLoading] = useState(false)
  const [exportingFormat, setExportingFormat] = useState('')
  const [previewMode, setPreviewMode] = useState('page')
  const [previewPage, setPreviewPage] = useState(1)
  const [activeTool, setActiveTool] = useState(() => getToolFromPath(window.location.pathname))
  const fileInputRef = useRef(null)

  const sheetNames = workbook?.SheetNames || []
  const activeSheetName = config.sheetName || sheetNames[0] || ''
  const worksheet = workbook && activeSheetName ? workbook.Sheets[activeSheetName] : null

  const rows = useMemo(() => {
    if (!worksheet) return SAMPLE_ROWS
    return extractPairsFromSheet(worksheet, config)
  }, [worksheet, config])

  const rowsPerPage = clampInt(config.rowsPerPage, 1, MAX_ROWS_PER_PAGE, DEFAULT_CONFIG.rowsPerPage)
  const previewPages = useMemo(() => paginateRows(rows, rowsPerPage), [rows, rowsPerPage])
  const safePreviewPage = Math.min(previewPage, previewPages.length)
  const currentPreviewRows = previewPages[safePreviewPage - 1] || []
  const previewRowScale = Math.min(1, DEFAULT_CONFIG.rowsPerPage / rowsPerPage)
  const previewRowUnit = (DEFAULT_CONFIG.rowsPerPage * 8.8) / rowsPerPage
  const previewGridRatio = 6 / previewRowUnit

  const stats = useMemo(
    () => ({
      rows: rows.length,
      englishCell: cellAddress(config.englishRow, config.englishCol),
      chineseCell: cellAddress(config.chineseRow, config.chineseCol),
      rowsPerPage,
      pages: previewPages.length,
      file: fileName,
      sheet: activeSheetName || '示例数据',
    }),
    [
      rows.length,
      rowsPerPage,
      previewPages.length,
      config.englishRow,
      config.englishCol,
      config.chineseRow,
      config.chineseCol,
      fileName,
      activeSheetName,
    ],
  )

  const updateConfig = (patch) => setConfig((current) => ({ ...current, ...patch }))

  const loadWorkbook = async (file) => {
    setIsLoading(true)
    setStatus('正在读取 XLSX 文件…')
    try {
      const data = await readFileAsArrayBuffer(file)
      const parsed = XLSX.read(data, {
        type: 'array',
        cellDates: true,
        cellText: true,
        WTF: false,
      })
      setWorkbook(parsed)
      setFileName(file.name || 'example.xlsx')
      updateConfig({ sheetName: parsed.SheetNames[0] || '' })
      setStatus(`已载入 ${file.name}，选择起始行列后可实时预览。`)
    } catch (error) {
      console.error(error)
      setStatus(`读取失败：${error?.message || '文件格式可能不正确'}`)
    } finally {
      setIsLoading(false)
    }
  }

  const loadBundledExample = async () => {
    setIsLoading(true)
    setStatus('正在加载内置 example.xlsx…')
    try {
      const response = await fetch('/example.xlsx')
      if (!response.ok) throw new Error('无法读取 public/example.xlsx')
      const blob = await response.blob()
      const file = new File([blob], 'example.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      await loadWorkbook(file)
    } catch (error) {
      console.warn(error)
      setStatus('未能加载内置 example.xlsx，你仍可上传本地文件。')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (window.location.pathname.startsWith('/listen')) return
    loadBundledExample()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const syncPath = () => setActiveTool(getToolFromPath(window.location.pathname))
    window.addEventListener('popstate', syncPath)
    return () => window.removeEventListener('popstate', syncPath)
  }, [])

  useEffect(() => {
    setPreviewPage((page) => Math.min(Math.max(1, page), previewPages.length))
  }, [previewPages.length])

  const setTool = (tool) => {
    setActiveTool(tool)
    window.history.pushState(null, '', getToolPath(tool))
  }

  const handleDrop = (event) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) loadWorkbook(file)
  }

  const handleFileInputChange = (event) => {
    const file = event.target.files?.[0]
    if (file) loadWorkbook(file)
    event.target.value = ''
  }

  const handleExportStandardPdf = async () => {
    setExportingFormat('standard-pdf')
    setStatus(`正在生成标准 PDF${config.showPracticeGrid ? '（四线三格）' : '（空白格）'}…`)
    try {
      const pdfBlob = await createPdfFromRows(rows, config, fileName)
      downloadBlob(pdfBlob, fileName)
      setStatus(`已导出 ${fileName.replace(/\.[^.]+$/, '') || 'example'}.pdf。`)
    } catch (error) {
      console.error(error)
      setStatus(`导出失败：${error?.message || '请重试'}`)
    } finally {
      setExportingFormat('')
    }
  }

  const handleExportTemplatePdf = async () => {
    setExportingFormat('template-pdf')
    setStatus('正在生成模板版 PDF…')
    try {
      const pdfBlob = await createTemplatePdfFromRows(rows, fileName)
      downloadTemplatePdfBlob(pdfBlob, fileName)
      setStatus('模板版 PDF 已导出。')
    } catch (error) {
      console.error(error)
      setStatus(`导出失败：${error?.message || '请重试'}`)
    } finally {
      setExportingFormat('')
    }
  }

  const handleExportTemplateXlsx = async () => {
    setExportingFormat('template-xlsx')
    setStatus('正在生成模板版 XLSX…')
    try {
      const xlsxBlob = await createTemplateXlsxBlob(rows, fileName)
      downloadNamedBlob(xlsxBlob, getTemplateWorkbookDownloadName(fileName))
      setStatus(`已导出 ${getTemplateWorkbookDownloadName(fileName)}。`)
    } catch (error) {
      console.error(error)
      setStatus(`导出失败：${error?.message || '请重试'}`)
    } finally {
      setExportingFormat('')
    }
  }

  if (window.location.pathname.startsWith('/listen')) return <MobileListenPage />

  const samplePreviewRows = rows.slice(0, 5)
  const emptyPreviewSlots = Math.max(0, rowsPerPage - currentPreviewRows.length)
  const heroMeta = {
    pdf: {
      pill: '保留标准 PDF，并新增模板版导出',
      title: '把英汉词表变成可打印 PDF。',
      description: '标准版沿用你原来的 PDF 版式；同时新增人教版模板 PDF 和模板 XLSX 导出。',
      mockTitle: '英汉词表',
      mockSubTitle: `${stats.file.replace(/\.[^.]+$/, '')}.pdf`,
      mockRight: (row) => row.chinese || '—',
    },
    tts: {
      pill: 'Edge TTS + 手机二维码播放',
      title: '生成单词朗读音频。',
      description: '粘贴或导入词表，选择英/美音、速度、音色和停顿，生成可试听 MP3，并用二维码在手机播放。',
      mockTitle: 'Audio batches',
      mockSubTitle: `${rows.length || 0} words`,
      mockRight: () => '▶︎  Edge neural voice',
    },
    gen: {
      pill: '受保护的服务端练习包生成',
      title: '把当前词表变成练习包。',
      description: '复用当前 XLSX 读表设置，在受保护页面里调用 Vercel Node.js 后端生成练习包，并以 ZIP 下载。',
      mockTitle: 'Worksheet pack',
      mockSubTitle: `${rows.length || 0} entries`,
      mockRight: () => '11 类题型 / 练习包',
    },
  }[activeTool]

  return (
    <main className="appShell">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        hidden
        onChange={handleFileInputChange}
      />
      <section className="heroPanel">
        <div className="ambient ambientOne" />
        <div className="ambient ambientTwo" />
        <nav className="topBar">
          <div className="brandMark">
            <FileSpreadsheet size={23} />
            <span>XLSX2PDF</span>
          </div>
          <div className="toolSwitch" role="group" aria-label="工具切换">
            <button
              className={activeTool === 'pdf' ? 'active' : ''}
              type="button"
              aria-pressed={activeTool === 'pdf'}
              onClick={() => setTool('pdf')}
            >
              <FileText size={15} /> PDF
            </button>
            <button
              className={activeTool === 'tts' ? 'active' : ''}
              type="button"
              aria-pressed={activeTool === 'tts'}
              onClick={() => setTool('tts')}
            >
              <Headphones size={15} /> 单词朗读
            </button>
            <button
              className={activeTool === 'gen' ? 'active' : ''}
              type="button"
              aria-pressed={activeTool === 'gen'}
              onClick={() => setTool('gen')}
            >
              <Sparkles size={15} /> 练习生成
            </button>
          </div>
        </nav>

        <div className="heroGrid">
          <div className="heroCopy">
            <Pill tone="blue">
              <Sparkles size={14} /> {heroMeta.pill}
            </Pill>
            <h1>{heroMeta.title}</h1>
            <p>{heroMeta.description}</p>
            <div className="heroActions">
              <UploadActions
                isLoading={isLoading}
                onUpload={() => fileInputRef.current?.click()}
                onUseExample={loadBundledExample}
              />
            </div>
          </div>

          <div className={activeTool === 'tts' ? 'paperMock audioMock' : 'paperMock'} aria-label="preview mock">
            <div className="paperHeader">
              <span>{heroMeta.mockTitle}</span>
              <small>{heroMeta.mockSubTitle}</small>
            </div>
            {samplePreviewRows.map((row) => (
              <div className="mockRow" key={`${row.index}-${row.english}`}>
                <strong>{row.english || '—'}</strong>
                <span>{heroMeta.mockRight(row)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {activeTool === 'tts' ? (
        <TtsWorkspace rows={rows} loadWorkbook={loadWorkbook} fileName={fileName} activeSheetName={activeSheetName} />
      ) : activeTool === 'gen' ? (
        <GenWorkspace rows={rows} fileName={fileName} activeSheetName={activeSheetName} />
      ) : (
        <section className="workspace">
          <aside className="controlRail">
            <div
              className="dropZone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              role="button"
              tabIndex={0}
            >
              <UploadCloud size={26} />
              <strong>上传或拖入 XLSX</strong>
              <span>{fileName}</span>
            </div>

            <div className="panelBlock">
              <div className="blockTitle">
                <SlidersHorizontal size={17} />
                <span>读取设置</span>
              </div>

              <label className="field fullField">
                <span>
                  <FileSpreadsheet size={15} />
                  工作表
                </span>
                <select
                  value={activeSheetName}
                  onChange={(event) => updateConfig({ sheetName: event.target.value })}
                  disabled={!sheetNames.length}
                >
                  {sheetNames.length ? (
                    sheetNames.map((name) => (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    ))
                  ) : (
                    <option>示例数据</option>
                  )}
                </select>
              </label>

              <div className="twoCols">
                <InputField
                  label="英语起始行"
                  value={config.englishRow}
                  onChange={(value) => updateConfig({ englishRow: value })}
                  icon={Rows3}
                />
                <InputField
                  label="英语起始列"
                  value={config.englishCol}
                  onChange={(value) => updateConfig({ englishCol: value })}
                  suffix={columnToLetter(config.englishCol)}
                  icon={Columns3}
                />
                <InputField
                  label="汉语起始行"
                  value={config.chineseRow}
                  onChange={(value) => updateConfig({ chineseRow: value })}
                  icon={Rows3}
                />
                <InputField
                  label="汉语起始列"
                  value={config.chineseCol}
                  onChange={(value) => updateConfig({ chineseCol: value })}
                  suffix={columnToLetter(config.chineseCol)}
                  icon={Columns3}
                />
              </div>
            </div>

            <div className="panelBlock">
              <div className="blockTitle">
                <FileText size={17} />
                <span>标准 PDF 设置</span>
              </div>
              <InputField
                label="每页行数"
                value={config.rowsPerPage}
                min={1}
                max={MAX_ROWS_PER_PAGE}
                onChange={(value) => updateConfig({ rowsPerPage: value })}
                suffix="行/页"
                icon={Rows3}
              />
              <InputField
                label="最多读取行数"
                value={config.maxRows}
                min={1}
                max={10000}
                onChange={(value) => updateConfig({ maxRows: value })}
                suffix="行"
              />
              <label className="field fullField fieldCheckbox">
                <span>
                  <FileText size={15} />
                  练习格子
                </span>
                <div className="checkboxShell">
                  <input
                    type="checkbox"
                    checked={Boolean(config.showPracticeGrid)}
                    onChange={(event) => updateConfig({ showPracticeGrid: event.target.checked })}
                  />
                  <small>{config.showPracticeGrid ? '四线三格' : '空白格子'}</small>
                </div>
              </label>
            </div>

            <button className="exportButton" onClick={handleExportStandardPdf} disabled={Boolean(exportingFormat) || !rows.length}>
              {exportingFormat === 'standard-pdf' ? <Loader2 className="spin" size={19} /> : <ArrowDownToLine size={19} />}
              导出标准 PDF
            </button>

            <div className="panelBlock">
              <div className="blockTitle">
                <FileSpreadsheet size={17} />
                <span>模板版导出</span>
              </div>
              <div className="exportStack">
                <button className="exportButton secondaryExportButton" onClick={handleExportTemplatePdf} disabled={Boolean(exportingFormat) || !rows.length}>
                  {exportingFormat === 'template-pdf' ? <Loader2 className="spin" size={19} /> : <FileText size={19} />}
                  导出模板 PDF
                </button>
                <button className="exportButton secondaryExportButton" onClick={handleExportTemplateXlsx} disabled={Boolean(exportingFormat) || !rows.length}>
                  {exportingFormat === 'template-xlsx' ? <Loader2 className="spin" size={19} /> : <FileSpreadsheet size={19} />}
                  导出模板 XLSX
                </button>
              </div>
            </div>

            <p className="statusLine">{status}</p>
          </aside>

          <section className="previewStage">
            <div className="stageHeader">
              <div>
                <span className="eyebrow">实时预览</span>
                <h2>{rows.length ? `${rows.length} 条词条` : '等待数据'}</h2>
              </div>
              <div className="modeSwitch" role="group" aria-label="预览模式">
                <button
                  className={previewMode === 'page' ? 'active' : ''}
                  onClick={() => setPreviewMode('page')}
                  type="button"
                  aria-pressed={previewMode === 'page'}
                >
                  页面
                </button>
                <button
                  className={previewMode === 'table' ? 'active' : ''}
                  onClick={() => setPreviewMode('table')}
                  type="button"
                  aria-pressed={previewMode === 'table'}
                >
                  数据
                </button>
              </div>
            </div>

            <div className="statStrip">
              <div>
                <small>文件</small>
                <strong>{stats.file}</strong>
              </div>
              <div>
                <small>工作表</small>
                <strong>{stats.sheet}</strong>
              </div>
              <div>
                <small>英语</small>
                <strong>{stats.englishCell}</strong>
              </div>
              <div>
                <small>汉语</small>
                <strong>{stats.chineseCell}</strong>
              </div>
              <div>
                <small>每页</small>
                <strong>{stats.rowsPerPage} 行</strong>
              </div>
              <div>
                <small>页数</small>
                <strong>{stats.pages} 页</strong>
              </div>
            </div>

            {previewMode === 'page' ? (
              <div className="pdfCanvas">
                <div className="pageControls">
                  <button
                    type="button"
                    onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}
                    disabled={safePreviewPage <= 1}
                  >
                    上一页
                  </button>
                  <span>
                    第 {safePreviewPage} / {previewPages.length} 页
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewPage((page) => Math.min(previewPages.length, page + 1))}
                    disabled={safePreviewPage >= previewPages.length}
                  >
                    下一页
                  </button>
                </div>

                <div className="templatePage">
                  <div
                    className="templateTable"
                    style={{
                      '--row-scale': previewRowScale,
                      '--grid-ratio': previewGridRatio,
                      gridTemplateRows: `7.4fr repeat(${rowsPerPage}, ${previewRowUnit}fr)`,
                    }}
                  >
                    <div className="templateHeader templateCell">序号</div>
                    <div className="templateHeader templateCell">英文</div>
                    <div className="templateHeader templateCell">默写汉语</div>
                    <div className="templateHeader templateCell">中文</div>
                    <div className="templateHeader templateCell">默写英文</div>

                    {currentPreviewRows.map((row) => (
                      <TemplateRow key={`${row.index}-${row.sourceRow || row.index}`} row={row} showPracticeGrid={Boolean(config.showPracticeGrid)} />
                    ))}

                    {Array.from({ length: emptyPreviewSlots }).map((_, index) => (
                      <TemplateRow key={`empty-${index}`} empty showPracticeGrid={Boolean(config.showPracticeGrid)} />
                    ))}
                  </div>
                  <div className="templatePageNumber">{safePreviewPage}</div>
                </div>
              </div>
            ) : (
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>源行</th>
                      <th>英语单元格</th>
                      <th>英语</th>
                      <th>汉语单元格</th>
                      <th>汉语</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${row.index}-${row.englishCell}-${row.chineseCell}`}>
                        <td>{row.index}</td>
                        <td>{row.sourceRow || row.index}</td>
                        <td>{row.englishCell || '—'}</td>
                        <td>{row.english || '—'}</td>
                        <td>{row.chineseCell || '—'}</td>
                        <td>{row.chinese || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </section>
      )}
    </main>
  )
}

export default App
