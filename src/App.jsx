import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import {
  ArrowDownToLine,
  Check,
  Columns3,
  FileSpreadsheet,
  FileText,
  Loader2,
  Rows3,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
} from 'lucide-react'
import {
  DEFAULT_CONFIG,
  SAMPLE_ROWS,
  cellAddress,
  clampInt,
  columnToLetter,
  extractPairsFromSheet,
} from './utils'
import { createPdfFromRows, downloadBlob } from './pdf'
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
  const fileInputRef = useRef(null)

  const sheetNames = workbook?.SheetNames || []
  const activeSheetName = config.sheetName || sheetNames[0] || ''
  const worksheet = workbook && activeSheetName ? workbook.Sheets[activeSheetName] : null

  const rows = useMemo(() => {
    if (!worksheet) return SAMPLE_ROWS
    return extractPairsFromSheet(worksheet, config)
  }, [worksheet, config])

  const stats = useMemo(
    () => ({
      rows: rows.length,
      englishCell: cellAddress(config.englishRow, config.englishCol),
      chineseCell: cellAddress(config.chineseRow, config.chineseCol),
      file: fileName,
      sheet: activeSheetName || '示例数据',
    }),
    [rows.length, config.englishRow, config.englishCol, config.chineseRow, config.chineseCol, fileName, activeSheetName],
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
    loadBundledExample()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const samplePreviewRows = rows.slice(0, 8)

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
          <div className="privacyNote">
            <Check size={15} />
            浏览器本地处理 · 适合部署到 Vercel
          </div>
        </nav>

        <div className="heroGrid">
          <div className="heroCopy">
            <Pill tone="blue">
              <Sparkles size={14} /> 自动从 example.xlsx 输出 example.pdf
            </Pill>
            <h1>把英汉词表变成可打印 PDF。</h1>
            <p>
              上传 XLSX，指定英语与汉语从哪一行、哪一列开始，实时查看排版，并用访问者电脑完成 PDF 生成。
            </p>
            <div className="heroActions">
              <button className="primaryButton" onClick={() => fileInputRef.current?.click()}>
                <UploadCloud size={18} /> 上传 XLSX
              </button>
              <button className="ghostButton" onClick={loadBundledExample} disabled={isLoading}>
                {isLoading ? <Loader2 className="spin" size={17} /> : <FileSpreadsheet size={17} />}
                使用 example.xlsx
              </button>
            </div>
          </div>

          <div className="paperMock" aria-label="PDF preview mock">
            <div className="paperHeader">
              <span>英汉词表</span>
              <small>{stats.file.replace(/\.[^.]+$/, '')}.pdf</small>
            </div>
            {samplePreviewRows.slice(0, 5).map((row) => (
              <div className="mockRow" key={`${row.index}-${row.english}`}>
                <strong>{row.english || '—'}</strong>
                <span>{row.chinese || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

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
            <label className="field fullField">
              <span>标题</span>
              <input
                type="text"
                value={config.title}
                onChange={(event) => updateConfig({ title: event.target.value })}
              />
            </label>
            <InputField
              label="自动换行字数"
              value={config.wrapChars}
              min={8}
              max={80}
              onChange={(value) => updateConfig({ wrapChars: value })}
              suffix="字/行"
            />
            <InputField
              label="最多读取行数"
              value={config.maxRows}
              min={1}
              max={2000}
              onChange={(value) => updateConfig({ maxRows: value })}
              suffix="行"
            />
            <label className="toggleLine">
              <input
                type="checkbox"
                checked={config.showIndex}
                onChange={(event) => updateConfig({ showIndex: event.target.checked })}
              />
              <span>导出序号列</span>
            </label>
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
          </div>

          {previewMode === 'page' ? (
            <div className="pdfCanvas">
              <div className="pdfPage">
                <div className="pdfTop">
                  <h3>{config.title || '英汉词表'}</h3>
                  <span>XLSX2PDF · A4</span>
                </div>
                <div className="pdfDivider" />
                <div className={`pdfHeaderRow ${config.showIndex ? '' : 'noIndex'}`}>
                  {config.showIndex ? <span>#</span> : null}
                  <span>English</span>
                  <span>中文释义</span>
                </div>
                <div className="pdfRows">
                  {samplePreviewRows.map((row) => (
                    <div className={`pdfDataRow ${config.showIndex ? '' : 'noIndex'}`} key={`${row.index}-${row.sourceRow || row.index}`}>
                      {config.showIndex ? <span className="rowIndex">{row.index}</span> : null}
                      <strong>{row.english || '—'}</strong>
                      <span>{row.chinese || '—'}</span>
                    </div>
                  ))}
                </div>
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
                  {rows.slice(0, 80).map((row) => (
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
    </main>
  )
}

export default App
