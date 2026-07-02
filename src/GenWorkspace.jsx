import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  Lock,
  RefreshCw,
  Square,
  Sparkles,
  Trash2,
  Upload,
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
  canceling: { label: '停止中', icon: Loader2 },
  completed: { label: '已完成', icon: CheckCircle2 },
  canceled: { label: '已取消', icon: XCircle },
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

const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0))

const getStageWordTotal = (job) => Number(job?.progress?.stageWordTotal || 0)
const getStageWordCompleted = (job) => {
  const total = getStageWordTotal(job)
  const completed = Number(job?.progress?.stageWordCompleted || 0)
  return total ? Math.max(0, Math.min(total, completed)) : 0
}

const formatWordProgress = (job) => {
  const total = getStageWordTotal(job)
  if (!total) return job?.wordCount ? `共 ${job.wordCount} 词` : '等待开始'
  return `${getStageWordCompleted(job)} / ${total}`
}

const getStageLabel = (job) => String(job?.progress?.stageLabel || job?.progress?.currentStep || '').trim() || '等待处理'

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
          lines: [`${cleanWord(row.english)}   &   ${index % 2 === 0 ? previewRelation(row.english, 'synonym') : previewRelation(row.english, 'antonym')}   (    )`],
        })),
        answers: sampleRows.map((row, index) => `${index + 1}.${index % 2 === 0 ? 'S' : 'A'}`),
      }
    case '七_同义词匹配':
      return {
        title: '同义词匹配',
        subtitle: '预览显示成块状配对题，方便看清版式密度。',
        items: mapItem((row, index) => {
          const left = `${index + 1}. ${cleanWord(row.english)}`.padEnd(22, ' ')
          return {
            no: index + 1,
            lines: [`${left}${'abcde'[index] || 'a'}. ${previewRelation(row.english, 'synonym')}`],
          }
        }),
        answers: sampleRows.map((row, index) => `${index + 1}.${index + 1}-${'abcde'[index] || 'a'}`),
      }
    case '八_反义词匹配':
      return {
        title: '反义词匹配',
        subtitle: '右栏预览即时切成反义词版式。',
        items: mapItem((row, index) => {
          const left = `${index + 1}. ${cleanWord(row.english)}`.padEnd(22, ' ')
          return {
            no: index + 1,
            lines: [`${left}${'abcde'[index] || 'a'}. ${previewRelation(row.english, 'antonym')}`],
          }
        }),
        answers: sampleRows.map((row, index) => `${index + 1}.${index + 1}-${'abcde'[index] || 'a'}`),
      }
    case '九_判断正误':
      return {
        title: '判断正误',
        subtitle: '预览展示 T / F 判断句式。',
        items: mapItem((row, index) => ({
          no: index + 1,
          lines: [`(    ) ${cleanWord(row.english)} is connected with ${cleanMeaning(row.chinese)}.`],
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
  const [cancelingJobId, setCancelingJobId] = useState('')
  const [deletingJobId, setDeletingJobId] = useState('')
  const [status, setStatus] = useState('')
  const [jobs, setJobs] = useState([])
  const [selectedTypes, setSelectedTypes] = useState(DEFAULT_QUESTION_TYPES)
  const [llmModels, setLlmModels] = useState([])
  const [selectedLlmModel, setSelectedLlmModel] = useState('')
  const [llmCacheAvailable, setLlmCacheAvailable] = useState(false)
  const [reuseLlmCache, setReuseLlmCache] = useState(true)

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
  const llmModelLabelById = useMemo(
    () => new Map(llmModels.map((item) => [item.id, item.label])),
    [llmModels],
  )

  const activeJobs = useMemo(
    () => jobs.filter((job) => ['queued', 'processing', 'canceling'].includes(job.status)),
    [jobs],
  )
  const completedCount = useMemo(
    () => jobs.filter((job) => job.status === 'completed').length,
    [jobs],
  )

  const latestJob = activeJobs[0] || jobs[0] || null
  const progressPercent = clampPercent(latestJob?.progress?.percent || 0)

  const loadJobs = async (silent = false) => {
    if (!silent) setQueueBusy(true)
    try {
      const data = await apiJson('/api/gen/jobs', { method: 'GET' })
      setJobs(Array.isArray(data.jobs) ? data.jobs : [])
      const models = Array.isArray(data.llmModels) ? data.llmModels : []
      setLlmModels(models)
      const cacheAvailable = Boolean(data.llmCacheAvailable)
      setLlmCacheAvailable(cacheAvailable)
      setReuseLlmCache((current) => (cacheAvailable ? current : false))
      setSelectedLlmModel((current) => {
        if (current && models.some((item) => item.id === current)) return current
        if (data.defaultLlmModel && models.some((item) => item.id === data.defaultLlmModel)) return data.defaultLlmModel
        return models[0]?.id || ''
      })
    } catch (error) {
      if (!silent) setStatus(error.message || '读取队列失败。')
    } finally {
      if (!silent) setQueueBusy(false)
    }
  }

  useEffect(() => {
    apiJson('/api/auth?action=me')
      .then((data) => {
        setAuthenticated(Boolean(data.authenticated))
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

  const login = async (event) => {
    event.preventDefault()
    setLoginError('')
    try {
      await apiJson('/api/auth?action=login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setAuthenticated(true)
      setPassword('')
      setStatus('')
    } catch (error) {
      setLoginError(error.message || '登录失败。')
    }
  }

  const toggleType = (key) => {
    setSelectedTypes((current) => {
      return current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
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
          llmModel: selectedLlmModel,
          reuseLlmCache,
        }),
      })
      setJobs((current) => [data.job, ...current.filter((job) => job.id !== data.job.id)])
      setStatus('已提交。')
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

  const cancelJob = async (job) => {
    if (!job?.id || ['completed', 'failed', 'canceled'].includes(job.status)) return
    setCancelingJobId(job.id)
    try {
      const data = await apiJson(`/api/gen/jobs?id=${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
      })
      if (data?.job) {
        setJobs((current) => current.map((item) => (item.id === data.job.id ? data.job : item)))
      }
      setStatus(job.status === 'queued' ? '任务已从服务器队列移除。' : '已向服务器发送停止请求。')
      loadJobs(true)
    } catch (error) {
      setStatus(error.message || '停止任务失败。')
    } finally {
      setCancelingJobId('')
    }
  }

  const deleteJob = async (job) => {
    if (!job?.id || ['processing', 'canceling'].includes(job.status)) return
    setDeletingJobId(job.id)
    try {
      await apiJson(`/api/gen/jobs?id=${encodeURIComponent(job.id)}&intent=delete`, {
        method: 'DELETE',
      })
      setJobs((current) => current.filter((item) => item.id !== job.id))
      setStatus('队列记录及对应文件已删除。')
    } catch (error) {
      setStatus(error.message || '删除队列记录失败。')
    } finally {
      setDeletingJobId('')
    }
  }

  const progressLabel = latestJob?.progress?.message || (activeJobs.length ? '服务器正在处理队列…' : '当前没有进行中的队列任务。')
  const stageLabel = latestJob ? getStageLabel(latestJob) : '等待处理'
  const stageWordProgress = latestJob ? formatWordProgress(latestJob) : '—'
  const latestMeta = STATUS_META[latestJob?.status] || STATUS_META.queued
  const latestStatusLabel = latestJob ? latestMeta.label : '队列空闲'
  const activeLlmOption = llmModels.find((item) => item.id === selectedLlmModel) || llmModels[0] || null
  const statusLead = activeJobs.length
    ? '服务器正在处理'
    : jobs.length
      ? '最近任务已结束'
      : '等待首个任务'

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
      <section className="ttsStage genStatusStage">
        <div className="genStatusHero">
          <div className="genStatusHeroHead">
            <div>
              <span className="eyebrow">Queue Monitor</span>
              <h2>任务监控</h2>
            </div>
            <span className={`genStatusChip ${latestJob?.status || 'idle'}`}>{latestStatusLabel}</span>
          </div>
          <p className="genStatusHeroText">{progressLabel}</p>
          <div className="genStatusHeroMeta">
            <span>{statusLead}</span>
            <strong>{stageLabel}</strong>
            <em>{stageWordProgress}</em>
          </div>
          <div className="genStatusHeroBar" aria-hidden="true">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <div className="genStatusSummary">
          <article>
            <small>队列中</small>
            <strong>{activeJobs.length}</strong>
          </article>
          <article>
            <small>已完成</small>
            <strong>{completedCount}</strong>
          </article>
          <article>
            <small>当前进度</small>
            <strong>{progressPercent}%</strong>
          </article>
          <article>
            <small>词条进度</small>
            <strong>{stageWordProgress}</strong>
          </article>
        </div>

        <div className="stageHeader genStageHeader genStatusHeader">
          <div>
            <span className="eyebrow">Server Queue</span>
            <h2>服务器队列</h2>
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
              const jobPercent = clampPercent(job.progress?.percent || 0)
              const canCancel = ['queued', 'processing', 'canceling'].includes(job.status)
              const stopping = cancelingJobId === job.id || job.status === 'canceling'
              const canDelete = !['processing', 'canceling'].includes(job.status)
              const deleting = deletingJobId === job.id
              return (
                <article className={`genQueueItem ${job.status}`} key={job.id}>
                  <div className="genQueueHead">
                    <div>
                      <strong>{job.fileName.replace(/\.[^.]+$/, '')}</strong>
                      <span>{formatTime(job.updatedAt || job.createdAt)}</span>
                    </div>
                    <Icon size={16} className={['processing', 'canceling'].includes(job.status) ? 'spin' : ''} />
                  </div>
                  <div className="genQueueMeta">
                    <span className={`genQueueChip ${job.status}`}>{meta.label}</span>
                    <span>{job.questionTypes?.length || 0} 题型</span>
                    {job.llmModel ? <span>{llmModelLabelById.get(job.llmModel) || job.llmModel}</span> : null}
                    <span>{job.reuseLlmCache === false ? '缓存关' : '缓存开'}</span>
                    <span>{formatWordProgress(job)}</span>
                  </div>
                  <p>{job.progress?.message || job.error || '等待处理。'}</p>
                  <div className="genQueueMetrics">
                    <span>{getStageLabel(job)}</span>
                    <strong>词条 {formatWordProgress(job)}</strong>
                    <em>{jobPercent}%</em>
                  </div>
                  <div className="genQueueProgressBar" aria-hidden="true">
                    <span style={{ width: `${jobPercent}%` }} />
                  </div>
                  <div className="genQueueFoot">
                    <small>{job.exportFileName || job.fileName.replace(/\.[^.]+$/, '')}</small>
                    <div className="genQueueActions">
                      {canCancel ? (
                        <button
                          className="genQueueStop"
                          type="button"
                          onClick={() => cancelJob(job)}
                          disabled={stopping}
                        >
                          {stopping ? <Loader2 className="spin" size={14} /> : <Square size={13} />}
                          {job.status === 'queued' ? '移除' : '停止'}
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button
                          className="genQueueDelete"
                          type="button"
                          onClick={() => deleteJob(job)}
                          disabled={deleting}
                        >
                          {deleting ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                          删除
                        </button>
                      ) : null}
                      {job.status === 'completed' ? (
                        <button type="button" onClick={() => downloadJob(job)} disabled={downloadingJobId === job.id}>
                          {downloadingJobId === job.id ? <Loader2 className="spin" size={14} /> : <ArrowDownToLine size={14} />}
                          下载
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              )
            }) : (
              <p className="genQueueEmpty">还没有已提交的练习任务。</p>
            )}
          </div>
        </div>

        <p className="statusLine genStatusLine">{status}</p>
      </section>

      <aside className="ttsControls genControls genConfigStage">
        <div className="panelBlock">
          <div className="blockTitle">
            <Sparkles size={17} />
            <span>提交配置</span>
          </div>
          <button
            className="exportButton genExportButton"
            type="button"
            onClick={generateArchive}
            disabled={busy || !usableRows.length || !selectedTypes.length}
          >
            {busy ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            提交队列
          </button>
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
            <div>
              <small>模型</small>
              <strong>{activeLlmOption?.label || '未配置'}</strong>
            </div>
            <div>
              <small>题型数</small>
              <strong>{selectedTypes.length}</strong>
            </div>
            <div>
              <small>缓存</small>
              <strong>{llmCacheAvailable ? (reuseLlmCache ? '复用中' : '关闭') : '未配置'}</strong>
            </div>
          </div>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <FileText size={17} />
            <span>选择题型</span>
          </div>
          {llmModels.length ? (
            <div className="field fullField">
              <span>LLM 模型</span>
              <select
                value={selectedLlmModel}
                onChange={(event) => setSelectedLlmModel(event.target.value)}
              >
                {llmModels.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </div>
          ) : null}
          <label className="toggleLine">
            <input
              type="checkbox"
              checked={reuseLlmCache}
              onChange={(event) => setReuseLlmCache(event.target.checked)}
              disabled={!llmCacheAvailable}
            />
            <span>{llmCacheAvailable ? '复用单词缓存' : '单词缓存未配置'}</span>
          </label>
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
      </aside>
    </section>
  )
}

export default GenWorkspace
