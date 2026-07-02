import React, { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ArrowDownToLine,
  FileSpreadsheet,
  FileText,
  Loader2,
  Lock,
  LogOut,
  Sparkles,
} from 'lucide-react'
import { apiJson, fetchDownloadBlob } from './api'
import { downloadNamedBlob } from './ttsUtils'
import { QUESTION_TYPE_OPTIONS, ALL_QUESTION_TYPE_KEYS } from '../shared/worksheetTypes'

const DEFAULT_QUESTION_TYPES = ALL_QUESTION_TYPE_KEYS

const formatBytes = (value) => {
  const size = Number(value) || 0
  if (!size) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const fallbackArchiveName = (fileName) => {
  const base = String(fileName || '词组练习')
    .replace(/\.[^.]+$/, '')
    .trim() || '词组练习'
  return `${base} 练习包.zip`
}

function GenWorkspace({ rows, fileName, activeSheetName }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('输入访问密码后即可生成练习包。')
  const [selectedTypes, setSelectedTypes] = useState(DEFAULT_QUESTION_TYPES)
  const [downloadState, setDownloadState] = useState({
    receivedBytes: 0,
    totalBytes: 0,
    fileName: '',
    completedAt: 0,
  })

  const usableRows = useMemo(
    () => rows.filter((row) => String(row?.english || '').trim()),
    [rows],
  )

  const selectedTypeMeta = useMemo(
    () => QUESTION_TYPE_OPTIONS.filter((item) => selectedTypes.includes(item.key)),
    [selectedTypes],
  )
  const llmTypeCount = useMemo(
    () => selectedTypeMeta.filter((item) => item.needsLlm).length,
    [selectedTypeMeta],
  )

  const progressPercent = downloadState.totalBytes
    ? Math.min(100, Math.round((downloadState.receivedBytes / downloadState.totalBytes) * 100))
    : busy && downloadState.receivedBytes
      ? 100
      : 0

  const taskState = busy ? '生成中' : downloadState.completedAt ? '已完成' : usableRows.length ? '已就绪' : '等待数据'
  const taskTone = busy ? 'running' : downloadState.completedAt ? 'done' : usableRows.length ? 'ready' : 'idle'

  useEffect(() => {
    apiJson('/api/auth/me')
      .then((data) => {
        setAuthenticated(Boolean(data.authenticated))
        if (data.authenticated) setStatus('已解锁练习生成板块。')
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true))
  }, [])

  const login = async (event) => {
    event.preventDefault()
    setLoginError('')
    try {
      await apiJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setAuthenticated(true)
      setPassword('')
      setStatus('已解锁练习生成板块。')
    } catch (error) {
      setLoginError(error.message || '登录失败。')
    }
  }

  const logout = async () => {
    await apiJson('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => {})
    setAuthenticated(false)
    setBusy(false)
    setStatus('已退出练习生成板块。')
    setDownloadState({
      receivedBytes: 0,
      totalBytes: 0,
      fileName: '',
      completedAt: 0,
    })
  }

  const toggleType = (key) => {
    setSelectedTypes((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ))
  }

  const generateArchive = async () => {
    if (!usableRows.length) {
      setStatus('当前词表没有可生成的英文词条。请先上传或调整读表设置。')
      return
    }
    if (!selectedTypes.length) {
      setStatus('请至少勾选一个题型。')
      return
    }

    setBusy(true)
    setDownloadState({
      receivedBytes: 0,
      totalBytes: 0,
      fileName: '',
      completedAt: 0,
    })
    setStatus(`正在用服务端生成 ${selectedTypes.length} 个题型的练习包…`)

    try {
      const { blob, fileName: downloadedName } = await fetchDownloadBlob(
        '/api/gen/export',
        {
          fileName,
          rows: usableRows,
          questionTypes: selectedTypes,
        },
        ({ receivedBytes, totalBytes }) => {
          setDownloadState((current) => ({
            ...current,
            receivedBytes,
            totalBytes,
          }))
        },
      )
      const archiveName = downloadedName || fallbackArchiveName(fileName)
      downloadNamedBlob(blob, archiveName)
      setDownloadState((current) => ({
        receivedBytes: blob.size || current.receivedBytes,
        totalBytes: blob.size || current.totalBytes,
        fileName: archiveName,
        completedAt: Date.now(),
      }))
      setStatus('练习包已生成，并已开始下载。')
    } catch (error) {
      setStatus(error.message || '练习包生成失败。')
    } finally {
      setBusy(false)
    }
  }

  if (!authChecked) {
    return (
      <section className="ttsGate">
        <Loader2 className="spin" size={28} />
        <p>正在检查访问权限…</p>
      </section>
    )
  }

  if (!authenticated) {
    return (
      <section className="ttsGate">
        <div className="gateCard">
          <Lock size={34} />
          <span className="eyebrow">Protected Worksheet</span>
          <h2>练习生成</h2>
          <p>该板块复用当前站点的密码保护。登录后由 Vercel Node.js 函数生成 ZIP 练习包，并以文件流返回浏览器下载。</p>
          <form onSubmit={login}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入访问密码"
              autoComplete="current-password"
            />
            <button className="primaryButton dark" type="submit">
              解锁
            </button>
          </form>
          {loginError ? <strong className="errorText">{loginError}</strong> : null}
        </div>
      </section>
    )
  }

  return (
    <section className="ttsWorkspace genWorkspace">
      <aside className="ttsControls genControls">
        <div className="panelBlock">
          <div className="blockTitle">
            <Archive size={17} />
            <span>生成范围</span>
          </div>
          <p className="statusLine">
            这里直接复用当前页面已经解析好的英汉词表。依赖 LLM 的题型会读取服务端环境变量里的 `VIVI_LLM_*` 配置。
          </p>
          <div className="genMetaGrid">
            <div>
              <small>当前文件</small>
              <strong>{fileName}</strong>
            </div>
            <div>
              <small>当前表</small>
              <strong>{activeSheetName || '示例数据'}</strong>
            </div>
            <div>
              <small>可用词条</small>
              <strong>{usableRows.length}</strong>
            </div>
            <div>
              <small>函数时长</small>
              <strong>300s</strong>
            </div>
            <div>
              <small>LLM 题型</small>
              <strong>{llmTypeCount}</strong>
            </div>
          </div>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <FileText size={17} />
            <span>题型选择</span>
          </div>
          <div className="questionTypeGrid">
            {QUESTION_TYPE_OPTIONS.map((item) => {
              const active = selectedTypes.includes(item.key)
              return (
                <label className={`questionTypeCard${active ? ' active' : ''}`} key={item.key}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleType(item.key)}
                  />
                  <strong>{item.title}</strong>
                  {item.needsLlm ? <em>LLM</em> : null}
                  <span>{item.description}</span>
                </label>
              )
            })}
          </div>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <Sparkles size={17} />
            <span>下载方式</span>
          </div>
          <p className="statusLine">
            服务端先生成练习目录并打包 ZIP，然后浏览器按文件流接收。下载阶段会显示已接收字节数；若勾选了 LLM 题型，会调用 `VIVI_LLM_BASE_URL` 和 `VIVI_LLM_MODEL`。
          </p>
          <div className="genMetaGrid">
            <div>
              <small>已选题型</small>
              <strong>{selectedTypeMeta.length}</strong>
            </div>
            <div>
              <small>LLM 题型</small>
              <strong>{llmTypeCount}</strong>
            </div>
            <div>
              <small>传输进度</small>
              <strong>{progressPercent}%</strong>
            </div>
            <div>
              <small>目标大小</small>
              <strong>{downloadState.totalBytes ? formatBytes(downloadState.totalBytes) : '等待返回'}</strong>
            </div>
            <div>
              <small>已接收</small>
              <strong>{formatBytes(downloadState.receivedBytes)}</strong>
            </div>
          </div>
        </div>

        <button className="exportButton" type="button" onClick={generateArchive} disabled={busy || !usableRows.length || !selectedTypes.length}>
          {busy ? <Loader2 className="spin" size={19} /> : <ArrowDownToLine size={19} />}
          生成 ZIP 练习包
        </button>

        <button className="logoutButton genLogoutButton" type="button" onClick={logout}>
          <LogOut size={16} />
          退出练习板块
        </button>

        <p className="statusLine">{status}</p>
      </aside>

      <section className="ttsStage genStage">
        <div className={`taskPanel ${taskTone}`}>
          <div className="taskPanelHeader">
            <div>
              <span className="eyebrow">Worksheet Export</span>
              <h3>练习生成</h3>
            </div>
            <strong>{taskState}</strong>
          </div>
          <p>当前版本复用主页面读表设置，从当前词表直接导出题目与答案 ZIP。后端生成完成后，文件会按流式响应传回浏览器。</p>
          <div className="taskProgress">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="taskMetrics">
            <div>
              <small>词条</small>
              <strong>{usableRows.length}</strong>
            </div>
            <div>
              <small>题型</small>
              <strong>{selectedTypeMeta.length}</strong>
            </div>
            <div>
              <small>LLM</small>
              <strong>{llmTypeCount}</strong>
            </div>
            <div>
              <small>下载</small>
              <strong>{downloadState.fileName || '等待生成'}</strong>
            </div>
          </div>
        </div>

        <div className="genContentGrid">
          <article className="genPanel">
            <div className="blockTitle">
              <FileSpreadsheet size={17} />
              <span>当前词表快照</span>
            </div>
            <div className="genRowsPreview">
              {usableRows.slice(0, 8).map((row) => (
                <div className="genRow" key={`${row.index}-${row.english}`}>
                  <strong>{row.english}</strong>
                  <span>{row.chinese || '—'}</span>
                </div>
              ))}
              {!usableRows.length ? <p className="genEmpty">当前还没有可用词条。</p> : null}
            </div>
          </article>

          <article className="genPanel">
            <div className="blockTitle">
              <Archive size={17} />
              <span>导出内容</span>
            </div>
            <div className="selectedTypeList">
              {selectedTypeMeta.map((item) => (
                <div className="selectedTypeItem" key={item.key}>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </div>
              ))}
            </div>
            <p className="genNote">
              ZIP 内会按题型分目录输出，包含题目和答案文件。勾选了 LLM 题型时，服务端会按环境变量配置去请求模型服务。
            </p>
          </article>
        </div>
      </section>
    </section>
  )
}

export default GenWorkspace
