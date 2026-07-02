import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { apiJson, fetchDownloadRequest } from './api'
import { downloadNamedBlob } from './ttsUtils'
import { ALL_QUESTION_TYPE_KEYS, QUESTION_TYPE_OPTIONS } from '../shared/worksheetTypes'

const DEFAULT_QUESTION_TYPES = ALL_QUESTION_TYPE_KEYS

const PREVIEW_RELATIONS = {
  cheat: { synonym: 'deceive', antonym: 'be honest' },
  share: { synonym: 'divide', antonym: 'keep' },
  energy: { synonym: 'power', antonym: 'weakness' },
  quick: { synonym: 'fast', antonym: 'slow' },
  wide: { synonym: 'broad', antonym: 'narrow' },
  relax: { synonym: 'rest', antonym: 'tense' },
  teacher: { synonym: 'instructor', antonym: 'student' },
  home: { synonym: 'house', antonym: 'outside' },
  offer: { synonym: 'provide', antonym: 'refuse' },
}

const STATUS_META = {
  queued: { label: '排队中', icon: Clock3 },
  processing: { label: '生成中', icon: RefreshCw },
  completed: { label: '已完成', icon: CheckCircle2 },
  failed: { label: '失败', icon: XCircle },
}

const formatBytes = (value) => {
  const size = Number(value) || 0
  if (!size) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const formatTime = (value) => {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

const fallbackArchiveName = (fileName) => {
  const base = String(fileName || '词组练习')
    .replace(/\.[^.]+$/, '')
    .trim() || '词组练习'
  return `${base} 练习包.zip`
}

const cleanMeaning = (value) => String(value || '')
  .replace(/\u00a0/g, ' ')
  .replace(/(?<![A-Za-z])(?:vt|vi|v|n|adj|adv|a|ad|pron|prep|conj|num|int|interj|det|aux|pl)\.\s*/gi, '')
  .replace(/\s+/g, ' ')
  .trim()

const cleanWord = (value) => String(value || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[’‘]/g, "'")
  .replace(/\([^)]*\)/g, '')
  .replace(/\s*\(.*$/, '')
  .replace(/\s*=\s*.*$/, '')
  .replace(/[^A-Za-z' -]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const spellingCore = (value) => {
  const word = cleanWord(value).toLowerCase()
  return word && !word.includes(' ') && /^[a-z]+$/.test(word) ? word : ''
}

const buildOptions = (rows, index, correctValue, pickField) => {
  const seen = new Set([correctValue])
  const options = []
  for (let offset = 1; offset < rows.length && options.length < 3; offset += 1) {
    const candidate = rows[(index + offset) % rows.length]
    const value = pickField(candidate)
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push(value)
  }
  while (options.length < 3) options.push(`备用选项 ${options.length + 1}`)
  return [correctValue, ...options]
}

const previewRelation = (english, relationKey) => {
  const key = cleanWord(english).toLowerCase()
  const relation = PREVIEW_RELATIONS[key]?.[relationKey]
  if (relation) return relation
  return relationKey === 'synonym' ? 'related word' : 'opposite idea'
}

const buildPreviewModel = (typeKey, rows) => {
  const sampleRows = rows.slice(0, Math.min(rows.length, 6))
  if (!sampleRows.length) {
    return {
      title: '等待词表',
      subtitle: '上传或调整读表设置后，这里会即时显示练习排版预览。',
      items: [],
      answers: [],
    }
  }

  const mapItem = (builder) => sampleRows.map((row, index) => builder(row, index))

  switch (typeKey) {
    case '一_释义匹配':
      return {
        title: '释义匹配',
        subtitle: '按题目页的节奏展示定义与四选项。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [
            `Definition: ${cleanMeaning(row.chinese) || 'a classroom-friendly meaning'}`,
            buildOptions(sampleRows, index, cleanWord(row.english), (item) => cleanWord(item.english))
              .map((item, optionIndex) => `${'ABCD'[optionIndex]}. ${item}`)
              .join('   '),
          ],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.A ${cleanWord(row.english)}`),
      }
    case '二_选择题':
      return {
        title: '单词选择题',
        subtitle: '实时预览会用稳定模板句代替 LLM 生成句。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [
            `The word meaning "${cleanMeaning(row.chinese)}" is ______.`,
            buildOptions(sampleRows, index, cleanWord(row.english), (item) => cleanWord(item.english))
              .map((item, optionIndex) => `${'ABCD'[optionIndex]}. ${item}`)
              .join('   '),
          ],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.A ${cleanWord(row.english)}`),
      }
    case '三_同义替换':
      return {
        title: '同义替换',
        subtitle: '预览展示句型与替换位，正式导出会走服务端题面。',
        items: mapItem((row, index) => {
          const synonym = previewRelation(row.english, 'synonym')
          return {
            no: index + 1,
            lines: [
              `${cleanWord(row.english)} means ${cleanMeaning(row.chinese)}.`,
              `The word "${cleanWord(row.english)}" can be replaced by _______.`,
              buildOptions(sampleRows, index, synonym, (item) => previewRelation(item.english, 'synonym'))
                .map((item, optionIndex) => `${'ABCD'[optionIndex]}. ${item}`)
                .join('   '),
            ],
          }
        }),
        answers: sampleRows.map((row, index) => `${index + 1}.A ${previewRelation(row.english, 'synonym')}`),
      }
    case '四_乱序拼写':
      return {
        title: '乱序拼写',
        subtitle: '按练习页样式即时展示打乱后的字母。',
        items: mapItem((row, index) => {
          const core = spellingCore(row.english) || cleanWord(row.english).replace(/\s+/g, '')
          const scrambled = core.length > 2 ? `${core.slice(1)} ${core[0]}` : core
          return {
            no: index + 1,
            lines: [`${scrambled.split('').join(' ')}   ->   ____________`, `(${cleanMeaning(row.chinese)})`],
          }
        }),
        answers: sampleRows.map((row, index) => `${index + 1}.${cleanWord(row.english)}`),
      }
    case '五_缺字母填空':
      return {
        title: '缺字母填空',
        subtitle: '每个词保留首字母，隐藏部分中段字母。',
        items: mapItem((row, index) => {
          const core = spellingCore(row.english) || cleanWord(row.english).replace(/\s+/g, '')
          const masked = core
            .split('')
            .map((char, charIndex) => (charIndex > 0 && charIndex % 3 === 0 ? '_' : char))
            .join(' ')
          return {
            no: index + 1,
            lines: [`${masked}`, `(${cleanMeaning(row.chinese)})`],
          }
        }),
        answers: sampleRows.map((row, index) => `${index + 1}.${cleanWord(row.english)}`),
      }
    case '六_同义反义辨析':
      return {
        title: '同反义辨析',
        subtitle: '一页里混合同义与反义对，保持课堂节奏。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [`${cleanWord(row.english)}   &   ${index % 2 === 0 ? previewRelation(row.english, 'synonym') : previewRelation(row.english, 'antonym')}   (   )`],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.${index % 2 === 0 ? 'S' : 'A'}`),
      }
    case '七_同义词匹配':
      return {
        title: '同义词匹配',
        subtitle: '预览显示成块状配对题，方便看清版式密度。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [`${index + 1}. ${cleanWord(row.english)}          ${'abcde'[index] || 'a'}. ${previewRelation(row.english, 'synonym')}`],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.${index + 1}-${'abcde'[index] || 'a'}`),
      }
    case '八_反义词匹配':
      return {
        title: '反义词匹配',
        subtitle: '右栏预览即时切成反义词版式。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [`${index + 1}. ${cleanWord(row.english)}          ${'abcde'[index] || 'a'}. ${previewRelation(row.english, 'antonym')}`],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.${index + 1}-${'abcde'[index] || 'a'}`),
      }
    case '九_判断正误':
      return {
        title: '判断正误',
        subtitle: '预览展示 T / F 判断句式。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [`( ) ${cleanWord(row.english)} is connected with ${cleanMeaning(row.chinese)}.`],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.${index % 2 === 0 ? 'T' : 'F'}`),
      }
    case '十_汉译英':
      return {
        title: '汉译英',
        subtitle: '右侧按译题页的四选一结构即时预览。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [
            cleanMeaning(row.chinese),
            buildOptions(sampleRows, index, cleanWord(row.english), (item) => cleanWord(item.english))
              .map((item, optionIndex) => `${'ABCD'[optionIndex]}. ${item}`)
              .join('   '),
          ],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.A ${cleanWord(row.english)}`),
      }
    case '十一_英译汉':
    default:
      return {
        title: '英译汉',
        subtitle: '实时预览会按照最终 PDF 的信息密度排列题目。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [
            cleanWord(row.english),
            buildOptions(sampleRows, index, cleanMeaning(row.chinese), (item) => cleanMeaning(item.chinese))
              .map((item, optionIndex) => `${'ABCD'[optionIndex]}. ${item}`)
              .join('   '),
          ],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.A ${cleanMeaning(row.chinese)}`),
      }
  }
}

function GenWorkspace({ rows, fileName, activeSheetName }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [busy, setBusy] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)
  const [downloadingJobId, setDownloadingJobId] = useState('')
  const [status, setStatus] = useState('输入访问密码后即可生成练习包。')
  const [jobs, setJobs] = useState([])
  const [selectedTypes, setSelectedTypes] = useState(DEFAULT_QUESTION_TYPES)
  const [activePreviewType, setActivePreviewType] = useState(DEFAULT_QUESTION_TYPES[0])

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

  const activeJobs = useMemo(
    () => jobs.filter((job) => ['queued', 'processing'].includes(job.status)),
    [jobs],
  )

  const latestJob = jobs[0] || null
  const progressPercent = Math.max(0, Math.min(100, Number(latestJob?.progress?.percent || 0)))
  const previewType = selectedTypeMeta.find((item) => item.key === activePreviewType) || selectedTypeMeta[0] || QUESTION_TYPE_OPTIONS[0]
  const previewModel = useMemo(
    () => buildPreviewModel(previewType?.key, usableRows),
    [previewType, usableRows],
  )

  const loadJobs = async (silent = false) => {
    if (!silent) setQueueBusy(true)
    try {
      const data = await apiJson('/api/gen/jobs', { method: 'GET' })
      setJobs(Array.isArray(data.jobs) ? data.jobs : [])
    } catch (error) {
      if (!silent) setStatus(error.message || '读取队列失败。')
    } finally {
      if (!silent) setQueueBusy(false)
    }
  }

  useEffect(() => {
    apiJson('/api/auth/me')
      .then((data) => {
        setAuthenticated(Boolean(data.authenticated))
        if (data.authenticated) setStatus('已解锁练习生成板块。')
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true))
  }, [])

  useEffect(() => {
    if (!authenticated) return
    loadJobs()
  }, [authenticated])

  useEffect(() => {
    if (!authenticated || !activeJobs.length) return
    const timer = window.setInterval(() => {
      loadJobs(true)
    }, 3500)
    return () => window.clearInterval(timer)
  }, [authenticated, activeJobs.length])

  useEffect(() => {
    if (selectedTypes.includes(activePreviewType)) return
    setActivePreviewType(selectedTypes[0] || QUESTION_TYPE_OPTIONS[0].key)
  }, [activePreviewType, selectedTypes])

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

  const toggleType = (key) => {
    setSelectedTypes((current) => {
      const next = current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
      if (next.length && (!current.includes(key) || activePreviewType === key)) {
        setActivePreviewType(current.includes(key) ? next[0] : key)
      }
      return next
    })
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
    setStatus(`正在提交 ${selectedTypes.length} 个题型到服务器队列…`)

    try {
      const data = await apiJson('/api/gen/jobs', {
        method: 'POST',
        body: JSON.stringify({
          fileName,
          rows: usableRows,
          questionTypes: selectedTypes,
        }),
      })
      setJobs((current) => [data.job, ...current.filter((job) => job.id !== data.job.id)])
      setStatus('已提交到服务器队列。页面刷新后仍可继续查看和下载。')
      loadJobs(true)
    } catch (error) {
      setStatus(error.message || '提交队列失败。')
    } finally {
      setBusy(false)
    }
  }

  const downloadJob = async (job) => {
    if (!job?.id) return
    setDownloadingJobId(job.id)
    try {
      const { blob, fileName: downloadedName } = await fetchDownloadRequest(
        `/api/gen/jobs/download?id=${encodeURIComponent(job.id)}`,
        { method: 'GET' },
      )
      downloadNamedBlob(blob, downloadedName || job.exportFileName || fallbackArchiveName(job.fileName))
      setStatus('练习包已开始下载。')
      loadJobs(true)
    } catch (error) {
      setStatus(error.message || '下载任务失败。')
    } finally {
      setDownloadingJobId('')
    }
  }

  const progressLabel = latestJob?.progress?.message || (activeJobs.length ? '服务器正在处理队列…' : '当前没有进行中的队列任务。')

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
            <Sparkles size={17} />
            <span>题型设置</span>
          </div>
          <div className="genMetaGrid genMetaCompact">
            <div>
              <small>当前文件</small>
              <strong>{fileName}</strong>
            </div>
            <div>
              <small>工作表</small>
              <strong>{activeSheetName || '示例数据'}</strong>
            </div>
            <div>
              <small>词条</small>
              <strong>{usableRows.length}</strong>
            </div>
            <div>
              <small>LLM</small>
              <strong>{llmTypeCount}</strong>
            </div>
          </div>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <FileText size={17} />
            <span>选择题型</span>
          </div>
          <div className="questionTypeGrid compact">
            {QUESTION_TYPE_OPTIONS.map((item) => {
              const active = selectedTypes.includes(item.key)
              return (
                <label className={`questionTypeCard compact${active ? ' active' : ''}`} key={item.key}>
                  <input
                    className="questionTypeInput"
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleType(item.key)}
                  />
                  <span className="questionTypeMark" aria-hidden="true" />
                  <strong>{item.title}</strong>
                  {item.needsLlm ? <em>LLM</em> : null}
                  <span>{item.description}</span>
                </label>
              )
            })}
          </div>
        </div>

        <div className="panelBlock genQueuePanel">
          <div className="blockTitle">
            <Clock3 size={17} />
            <span>服务器队列</span>
            <button className="genQueueRefresh" type="button" onClick={() => loadJobs()} disabled={queueBusy}>
              {queueBusy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              刷新
            </button>
          </div>
          <div className="genQueueList">
            {jobs.length ? jobs.map((job) => {
              const meta = STATUS_META[job.status] || STATUS_META.queued
              const Icon = meta.icon
              return (
                <article className={`genQueueItem ${job.status}`} key={job.id}>
                  <div className="genQueueHead">
                    <div>
                      <strong>{job.fileName.replace(/\.[^.]+$/, '')}</strong>
                      <span>{meta.label} · {job.questionTypes?.length || 0} 题型</span>
                    </div>
                    <Icon size={16} className={job.status === 'processing' ? 'spin' : ''} />
                  </div>
                  <p>{job.progress?.message || job.error || '等待处理。'}</p>
                  <div className="genQueueFoot">
                    <small>{formatTime(job.updatedAt || job.createdAt)}</small>
                    {job.status === 'completed' ? (
                      <button type="button" onClick={() => downloadJob(job)} disabled={downloadingJobId === job.id}>
                        {downloadingJobId === job.id ? <Loader2 className="spin" size={14} /> : <ArrowDownToLine size={14} />}
                        下载
                      </button>
                    ) : null}
                  </div>
                </article>
              )
            }) : (
              <p className="genQueueEmpty">还没有已提交的练习任务。</p>
            )}
          </div>
        </div>

        <p className="statusLine genStatusLine">{status}</p>
      </aside>

      <section className="previewStage genPreviewStage">
        <div className="stageHeader genStageHeader">
          <div>
            <span className="eyebrow">实时预览</span>
            <h2>{previewModel.title}</h2>
            <p className="genStageSubtitle">{previewModel.subtitle}</p>
          </div>
          <div className="stageActions">
            <button
              className="exportButton genExportButton"
              type="button"
              onClick={generateArchive}
              disabled={busy || !usableRows.length || !selectedTypes.length}
            >
              {busy ? <Loader2 className="spin" size={18} /> : <ArrowDownToLine size={18} />}
              提交队列
            </button>
          </div>
        </div>

        <div className="statStrip genStatStrip">
          <div>
            <small>队列中</small>
            <strong>{activeJobs.length}</strong>
          </div>
          <div>
            <small>已完成</small>
            <strong>{jobs.filter((job) => job.status === 'completed').length}</strong>
          </div>
          <div>
            <small>当前进度</small>
            <strong>{progressPercent}%</strong>
          </div>
          <div>
            <small>最近成品</small>
            <strong>{latestJob?.exportFileName || '等待生成'}</strong>
          </div>
        </div>

        <div className="genQueueBanner">
          <RefreshCw size={15} className={activeJobs.length ? 'spin' : ''} />
          <span>{progressLabel}</span>
        </div>

        <div className="genPreviewRail">
          {selectedTypeMeta.map((item) => (
            <button
              key={item.key}
              className={`genPreviewChip${activePreviewType === item.key ? ' active' : ''}`}
              type="button"
              onClick={() => setActivePreviewType(item.key)}
            >
              {item.title}
            </button>
          ))}
        </div>

        <div className="genPreviewCanvas">
          <div className="genPreviewPaper">
            <div className="genPreviewPaperHeader">
              <span>{previewModel.title}</span>
              <small>{fileName.replace(/\.[^.]+$/, '') || 'worksheet-preview'}.pdf</small>
            </div>
            <div className="genPreviewPaperBody">
              {previewModel.items.map((item) => (
                <article className="genPreviewQuestion" key={`${previewType.key}-${item.no}`}>
                  <strong>{item.no}.</strong>
                  <div>
                    {item.lines.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <div className="genPreviewPageNumber">1</div>
          </div>

          <aside className="genAnswerPanel">
            <div className="genAnswerPanelHeader">
              <strong>答案预览</strong>
              <span>{previewType.title}</span>
            </div>
            <div className="genAnswerList">
              {previewModel.answers.map((answer) => (
                <p key={answer}>{answer}</p>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </section>
  )
}

export default GenWorkspace
