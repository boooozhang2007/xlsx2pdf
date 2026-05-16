import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  ArrowDownToLine,
  Check,
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
import MobileListenPage from './MobileListenPage'
import TtsWorkspace from './TtsWorkspace'
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

function App() {
  const [workbook, setWorkbook] = useState(null)
  const [fileName, setFileName] = useState('example.xlsx')
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [status, setStatus] = useState('已内置 example.xlsx，可直接预览或重新上传文件。')
  const [isLoading, setIsLoading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [previewMode, setPreviewMode] = useState('page')
  const [previewPage, setPreviewPage] = useState(1)
  const [activeTool, setActiveTool] = useState(() => (window.location.pathname.startsWith('/tts') ? 'tts' : 'pdf'))
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
  const previewGridRatio = Math.min(6, previewRowUnit * (6 / 8.8)) / previewRowUnit

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
    const syncPath = () => setActiveTool(window.location.pathname.startsWith('/tts') ? 'tts' : 'pdf')
    window.addEventListener('popstate', syncPath)
    return () => window.removeEventListener('popstate', syncPath)
  }, [])

  useEffect(() => {
    setPreviewPage((page) => Math.min(Math.max(1, page), previewPages.length))
  }, [previewPages.length])

  const setTool = (tool) => {
    setActiveTool(tool)
    window.history.pushState(null, '', tool === 'tts' ? '/tts' : '/')
  }

  const handleDrop = (event) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) loadWorkbook(file)
  }

  const handleExport = async () => {
    setIsExporting(true)
    setStatus('正在用访问者电脑资源生成 PDF…')
    try {
      const pdfBlob = await createPdfFromRows(rows, config, fileName)
      downloadBlob(pdfBlob, fileName)
      setStatus(`已导出 ${fileName.replace(/\.[^.]+$/, '') || 'example'}.pdf。`)
    } catch (error) {
      console.error(error)
      setStatus(`导出失败：${error?.message || '请重试'}`)
    } finally {
      setIsExporting(false)
    }
  }

  if (window.location.pathname.startsWith('/listen')) return <MobileListenPage />

  const samplePreviewRows = rows.slice(0, 5)
  const emptyPreviewSlots = Math.max(0, rowsPerPage - currentPreviewRows.length)

  return (
    <main className="appShell">
      <section className="heroPanel">
        <div className="ambient ambientOne" />
        <div className="ambient ambientTwo" />
        <nav className="topBar">
          <div className="brandMark">
            <FileSpreadsheet size={23} />
            <span>XLSX2PDF</span>
          </div>
          <div className="toolSwitch" role="tablist" aria-label="tool switch">
            <button className={activeTool === 'pdf' ? 'active' : ''} type="button" onClick={() => setTool('pdf')}>
              <FileText size={15} /> PDF
            </button>
            <button className={activeTool === 'tts' ? 'active' : ''} type="button" onClick={() => setTool('tts')}>
              <Headphones size={15} /> 单词朗读
            </button>
          </div>
          <div className="privacyNote">
            <Check size={15} />
            浏览器本地处理 · 适合部署到 Vercel
          </div>
        </nav>

        <div className="heroGrid">
          <div className="heroCopy">
            <Pill tone="blue">
              <Sparkles size={14} /> {activeTool === 'tts' ? 'Azure TTS + 手机二维码播放' : '自动从 example.xlsx 输出 example.pdf'}
            </Pill>
            <h1>{activeTool === 'tts' ? '生成单词朗读音频。' : '把英汉词表变成可打印 PDF。'}</h1>
            <p>
              {activeTool === 'tts'
                ? '粘贴或导入词表，选择英/美音、速度、音色和停顿，生成可试听 MP3，并用二维码在手机播放。'
                : '上传 XLSX，指定英语与汉语从哪一行、哪一列开始，实时查看排版，并用访问者电脑完成 PDF 生成。'}
            </p>
            <div className="heroActions">
              {activeTool === 'tts' ? (
                <>
                  <button className="primaryButton" onClick={() => setTool('tts')}>
                    <Headphones size={18} /> 打开朗读板块
                  </button>
                  <button className="ghostButton" onClick={() => setTool('pdf')}>
                    <FileText size={17} /> 返回 PDF
                  </button>
                </>
              ) : (
                <>
                  <button className="primaryButton" onClick={() => fileInputRef.current?.click()}>
                    <UploadCloud size={18} /> 上传 XLSX
                  </button>
                  <button className="ghostButton" onClick={loadBundledExample} disabled={isLoading}>
                    {isLoading ? <Loader2 className="spin" size={17} /> : <FileSpreadsheet size={17} />}
                    使用 example.xlsx
                  </button>
                </>
              )}
            </div>
          </div>

          <div className={activeTool === 'tts' ? 'paperMock audioMock' : 'paperMock'} aria-label="preview mock">
            <div className="paperHeader">
              <span>{activeTool === 'tts' ? 'Audio batches' : '英汉词表'}</span>
              <small>{activeTool === 'tts' ? `${rows.length || 0} words` : `${stats.file.replace(/\.[^.]+$/, '')}.pdf`}</small>
            </div>
            {samplePreviewRows.map((row) => (
              <div className="mockRow" key={`${row.index}-${row.english}`}>
                <strong>{row.english || '—'}</strong>
                <span>{activeTool === 'tts' ? '▶︎  Azure neural voice' : row.chinese || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {activeTool === 'tts' ? (
        <TtsWorkspace rows={rows} loadWorkbook={loadWorkbook} fileName={fileName} activeSheetName={activeSheetName} />
      ) : (
      <section className="workspace">
        <aside className="controlRail">
          <div
            className="dropZone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) loadWorkbook(file)
                event.target.value = ''
              }}
            />
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
              <span>PDF 设置</span>
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
          </div>

          <button className="exportButton" onClick={handleExport} disabled={isExporting || !rows.length}>
            {isExporting ? <Loader2 className="spin" size={19} /> : <ArrowDownToLine size={19} />}
            导出 {fileName.replace(/\.[^.]+$/, '') || 'example'}.pdf
          </button>

          <p className="statusLine">{status}</p>
        </aside>

        <section className="previewStage">
          <div className="stageHeader">
            <div>
              <span className="eyebrow">实时预览</span>
              <h2>{rows.length ? `${rows.length} 条词条` : '等待数据'}</h2>
            </div>
            <div className="modeSwitch" role="tablist" aria-label="preview mode">
              <button
                className={previewMode === 'page' ? 'active' : ''}
                onClick={() => setPreviewMode('page')}
                type="button"
              >
                页面
              </button>
              <button
                className={previewMode === 'table' ? 'active' : ''}
                onClick={() => setPreviewMode('table')}
                type="button"
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
                    <React.Fragment key={`${row.index}-${row.sourceRow || row.index}`}>
                      <div className="templateCell indexCell">{row.index}</div>
                      <div className="templateCell englishCell">{row.english || '—'}</div>
                      <div className="templateCell writeChineseCell" />
                      <div className="templateCell chineseCell">{row.chinese || '—'}</div>
                      <div className="templateCell writeEnglishCell">
                        <img src="/fourline.png" alt="" />
                      </div>
                    </React.Fragment>
                  ))}

                  {Array.from({ length: emptyPreviewSlots }).map((_, index) => (
                    <React.Fragment key={`empty-${index}`}>
                      <div className="templateCell indexCell" />
                      <div className="templateCell englishCell" />
                      <div className="templateCell writeChineseCell" />
                      <div className="templateCell chineseCell" />
                      <div className="templateCell writeEnglishCell">
                        <img src="/fourline.png" alt="" />
                      </div>
                    </React.Fragment>
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

