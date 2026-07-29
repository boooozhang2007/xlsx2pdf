import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { ALL_QUESTION_TYPE_KEYS, FIXED_TEST_PAPER_QUESTION_KEYS, FIXED_TEST_PAPER_SECTIONS, QUESTION_TYPE_OPTIONS } from '../shared/worksheetTypes'
import {
  DEFAULT_LEGACY_QUESTION_COUNT,
  GENERATION_MODE_FIXED_TEST_PAPER,
  GENERATION_MODE_LEGACY_ZIP,
  GENERATION_MODE_OPTIONS,
  TEST_PAPER_GROUP_SIZE_OPTIONS,
  normalizeLegacyQuestionCount,
  normalizeWithChineseTranslation,
} from '../shared/generationModes'

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
  const base = String(fileName || '词汇测试卷')
    .replace(/\.[^.]+$/, '')
    .trim() || '词汇测试卷'
  return `${base} 测试卷包.zip`
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
  const [reexportingJobId, setReexportingJobId] = useState('')
  const [cancelingJobId, setCancelingJobId] = useState('')
  const [deletingJobId, setDeletingJobId] = useState('')
  const [status, setStatus] = useState('')
  const [jobs, setJobs] = useState([])
  const [selectedGenerationMode, setSelectedGenerationMode] = useState(GENERATION_MODE_FIXED_TEST_PAPER)
  const [selectedTypes, setSelectedTypes] = useState(DEFAULT_QUESTION_TYPES)
  const [legacyQuestionCount, setLegacyQuestionCount] = useState(DEFAULT_LEGACY_QUESTION_COUNT)
  const [testPaperGroupSizes, setTestPaperGroupSizes] = useState([100])
  const [withChineseTranslation, setWithChineseTranslation] = useState(true)
  const [llmModels, setLlmModels] = useState([])
  const [selectedLlmModel, setSelectedLlmModel] = useState('')
  const jobsRequestIdRef = useRef(0)
  const queueBusyRequestIdRef = useRef(0)
  const submitInFlightRef = useRef(false)

  const usableRows = useMemo(
    () => rows.filter((row) => String(row?.english || '').trim()),
    [rows],
  )
  const paperCount = useMemo(
    () => testPaperGroupSizes.reduce((total, size) => (
      total + Math.max(1, Math.ceil(usableRows.length / (size || Math.max(1, usableRows.length))))
    ), 0),
    [testPaperGroupSizes, usableRows.length],
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
    const requestId = jobsRequestIdRef.current + 1
    jobsRequestIdRef.current = requestId
    if (!silent) {
      queueBusyRequestIdRef.current = requestId
      setQueueBusy(true)
    }
    try {
      const data = await apiJson('/api/gen/jobs', { method: 'GET' })
      if (requestId !== jobsRequestIdRef.current) return
      setJobs(Array.isArray(data.jobs) ? data.jobs : [])
      const models = Array.isArray(data.llmModels) ? data.llmModels : []
      setLlmModels(models)
      setSelectedLlmModel((current) => {
        if (current && models.some((item) => item.id === current)) return current
        if (data.defaultLlmModel && models.some((item) => item.id === data.defaultLlmModel)) return data.defaultLlmModel
        return models[0]?.id || ''
      })
    } catch (error) {
      if (!silent && requestId === jobsRequestIdRef.current) setStatus(error.message || '读取队列失败。')
    } finally {
      if (!silent && requestId === queueBusyRequestIdRef.current) setQueueBusy(false)
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
    setSelectedTypes((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ))
  }

  const toggleTestPaperGroupSize = (value) => {
    setTestPaperGroupSizes((current) => {
      if (!current.includes(value)) return [...current, value]
      return current.length > 1 ? current.filter((item) => item !== value) : current
    })
  }

  const generateArchive = async () => {
    if (submitInFlightRef.current) return
    if (!usableRows.length) {
      setStatus('当前词表没有可生成的英文词条。请先上传或调整读表设置。')
      return
    }
    if (selectedGenerationMode === GENERATION_MODE_LEGACY_ZIP && !selectedTypes.length) {
      setStatus('当前格式 ZIP 至少需要勾选一个题型。')
      return
    }

    submitInFlightRef.current = true
    setBusy(true)
    setStatus(
      selectedGenerationMode === GENERATION_MODE_FIXED_TEST_PAPER
        ? `正在提交模板测试卷到服务器队列…预计生成 ${paperCount} 份。`
        : `正在提交当前格式 ZIP 到服务器队列…共 ${selectedTypes.length} 个题型。`,
    )

    try {
      const data = await apiJson('/api/gen/jobs', {
        method: 'POST',
        body: JSON.stringify({
          fileName,
          rows: usableRows,
          generationMode: selectedGenerationMode,
          questionTypes: selectedGenerationMode === GENERATION_MODE_FIXED_TEST_PAPER ? FIXED_TEST_PAPER_QUESTION_KEYS : selectedTypes,
          llmModel: selectedLlmModel,
          legacyQuestionCount: normalizeLegacyQuestionCount(legacyQuestionCount),
          testPaperGroupSizes,
          withChineseTranslation: normalizeWithChineseTranslation(withChineseTranslation),
        }),
      })
      setJobs((current) => [data.job, ...current.filter((job) => job.id !== data.job.id)])
      setStatus(data.deduplicated ? '相同任务已在服务器处理，已转到原任务。' : '已提交。')
      loadJobs(true)
    } catch (error) {
      setStatus(error.message || '提交队列失败。')
    } finally {
      submitInFlightRef.current = false
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
      setStatus('测试卷包已开始下载。')
      loadJobs(true)
    } catch (error) {
      setStatus(error.message || '下载任务失败。')
    } finally {
      setDownloadingJobId('')
    }
  }

  const reexportJob = async (job) => {
    if (!job?.id) return
    setReexportingJobId(job.id)
    setStatus('正在复用 LLM 数据重新导出…')
    try {
      const { blob, fileName: downloadedName } = await fetchDownloadRequest(
        `/api/gen/jobs/download?id=${encodeURIComponent(job.id)}&reexport=1`,
        { method: 'GET' },
      )
      downloadNamedBlob(blob, downloadedName || job.exportFileName || fallbackArchiveName(job.fileName))
      setStatus('已用最新规则重新导出，下载已开始。')
    } catch (error) {
      setStatus(error.message || '重新导出失败。')
    } finally {
      setReexportingJobId('')
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
  const activeModeMeta = GENERATION_MODE_OPTIONS.find((item) => item.key === selectedGenerationMode) || GENERATION_MODE_OPTIONS[0]
  const activeLegacyLlmCount = QUESTION_TYPE_OPTIONS.filter((item) => item.needsLlm && selectedTypes.includes(item.key)).length

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

        {/* Live job card — stage + word progress front and center */}
        <div className="genLiveCard">
          <div className="genLiveTop">
            <span className={`genStatusChip ${latestJob?.status || 'idle'}`}>{latestStatusLabel}</span>
            <span className="genLivePercent">{progressPercent}%</span>
          </div>

          <div className="genLiveStage">
            {activeJobs.length
              ? <RefreshCw className="spin genLiveIcon" size={15} />
              : latestJob?.status === 'completed'
                ? <CheckCircle2 className="genLiveIcon done" size={15} />
                : <Clock3 className="genLiveIcon idle" size={15} />}
            <span className="genLiveStageName">{stageLabel}</span>
          </div>

          {latestJob && getStageWordTotal(latestJob) > 0 ? (
            <div className="genLiveWords">
              <span className="genLiveWordNum">{getStageWordCompleted(latestJob)}</span>
              <span className="genLiveWordSep">/</span>
              <span className="genLiveWordTotal">{getStageWordTotal(latestJob)}</span>
              <span className="genLiveWordLabel">词条</span>
            </div>
          ) : (
            <div className="genLiveWords">
              <span className="genLiveWordLabel">{latestJob?.wordCount ? `共 ${latestJob.wordCount} 词条` : '等待任务'}</span>
            </div>
          )}

          <div className="genStatusHeroBar" aria-hidden="true">
            <span style={{ width: `${progressPercent}%` }} />
          </div>

          {latestJob?.progress?.message ? (
            <p className="genLiveMessage">{latestJob.progress.message}</p>
          ) : null}
        </div>

        {/* Compact counters */}
        <div className="genStatsRow">
          <div className="genStatItem">
            <span>处理中</span>
            <strong>{activeJobs.length}</strong>
          </div>
          <div className="genStatItem">
            <span>已完成</span>
            <strong>{completedCount}</strong>
          </div>
          <div className="genStatItem">
            <span>总任务</span>
            <strong>{jobs.length}</strong>
          </div>
        </div>

        {/* Queue list */}
        <div className="panelBlock genQueuePanel">
          <div className="blockTitle">
            <Clock3 size={17} />
            <span>队列记录</span>
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
              const jobStageTotal = getStageWordTotal(job)
              const jobStageDone = getStageWordCompleted(job)
              const canCancel = ['queued', 'processing', 'canceling'].includes(job.status)
              const stopping = cancelingJobId === job.id || job.status === 'canceling'
              const canDelete = !['processing', 'canceling'].includes(job.status)
              const deleting = deletingJobId === job.id
              const isActive = ['processing', 'canceling'].includes(job.status)
              return (
                <article className={`genQueueItem ${job.status}`} key={job.id}>

                  {/* Top bar: status chip + meta + time */}
                  <div className="genQueueHead">
                    <div className="genQueueHeadLeft">
                      <span className={`genQueueChip ${job.status}`}>{meta.label}</span>
                      <span className="genQueueMetaText">
                        {job.generationMode === GENERATION_MODE_FIXED_TEST_PAPER
                          ? `模板·${(job.testPaperGroupSizes || [100]).map((size) => size || '全部').join('/')}`
                          : `ZIP·每组${job.legacyQuestionCount || DEFAULT_LEGACY_QUESTION_COUNT}题`}
                        {job.withChineseTranslation === false ? '·无中文' : ''}
                      </span>
                    </div>
                    <span className="genQueueTime">{formatTime(job.updatedAt || job.createdAt)}</span>
                  </div>

                  {/* Main: left = info, right = vertical actions */}
                  <div className="genQueueBody">
                    <div className="genQueueBodyInfo">
                      <div className="genQueueFileName" title={job.fileName}>
                        {job.fileName.replace(/\.[^.]+$/, '')}
                      </div>
                      <div className="genQueueStageRow">
                        <Icon size={13} className={isActive ? 'spin genQueueStageIcon' : 'genQueueStageIcon'} />
                        {jobStageTotal > 0 ? (
                          <span className="genQueueWordCount">词条 {jobStageDone}/{jobStageTotal}</span>
                        ) : (
                          job.wordCount ? <span className="genQueueWordCount">共 {job.wordCount} 词</span> : null
                        )}
                        <span className="genQueuePct">{jobPercent}%</span>
                      </div>
                      <div className="genQueueProgressBar" aria-hidden="true">
                        <span style={{ width: `${jobPercent}%` }} />
                      </div>
                      {(job.error || (job.status === 'failed' && job.progress?.message)) ? (
                        <p className="genQueueError">{job.error || job.progress?.message}</p>
                      ) : null}
                    </div>
                    <div className="genQueueActions">
                      {canCancel ? (
                        <button className="genQueueStop" type="button" onClick={() => cancelJob(job)} disabled={stopping}>
                          {stopping ? <Loader2 className="spin" size={13} /> : <Square size={13} />}
                          {job.status === 'queued' ? '移除' : '停止'}
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button className="genQueueDelete" type="button" onClick={() => deleteJob(job)} disabled={deleting}>
                          {deleting ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
                          删除
                        </button>
                      ) : null}
                      {job.status === 'completed' ? (
                        <>
                          <button className="genQueueReexport" type="button" onClick={() => reexportJob(job)} disabled={reexportingJobId === job.id}>
                            {reexportingJobId === job.id ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                            重新导出
                          </button>
                          <button type="button" onClick={() => downloadJob(job)} disabled={downloadingJobId === job.id}>
                            {downloadingJobId === job.id ? <Loader2 className="spin" size={13} /> : <ArrowDownToLine size={13} />}
                            下载
                          </button>
                        </>
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
            disabled={busy || !usableRows.length}
          >
            {busy ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            {selectedGenerationMode === GENERATION_MODE_FIXED_TEST_PAPER ? '提交测试卷队列' : '提交 ZIP 队列'}
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
              <small>模型</small>
              <strong>{activeLlmOption?.label || '未配置'}</strong>
            </div>
            <div>
              <small>模式</small>
              <strong>{activeModeMeta?.title || '模板测试卷'}</strong>
            </div>
            <div>
              <small>需 LLM</small>
              <strong>{selectedGenerationMode === GENERATION_MODE_FIXED_TEST_PAPER ? FIXED_TEST_PAPER_SECTIONS.filter((item) => item.needsLlm).length : activeLegacyLlmCount}</strong>
            </div>
          </div>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <FileText size={17} />
            <span>生成模式</span>
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
          <div className="questionTypeGrid compact">
            {GENERATION_MODE_OPTIONS.map((item) => {
              const active = selectedGenerationMode === item.key
              return (
                <label className={`questionTypeCard compact${active ? ' active' : ''}`} key={item.key}>
                  <input
                    className="questionTypeInput"
                    type="radio"
                    name="generationMode"
                    checked={active}
                    onChange={() => setSelectedGenerationMode(item.key)}
                  />
                  <span className="questionTypeMark" aria-hidden="true" />
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </label>
              )
            })}
          </div>

          {selectedGenerationMode === GENERATION_MODE_FIXED_TEST_PAPER ? (
            <>
              <div className="field fullField">
                <span>导出规格（可多选，共用一次题面生成）</span>
                <div className="exportSizeSelector">
                  {TEST_PAPER_GROUP_SIZE_OPTIONS.map((item) => {
                    const active = testPaperGroupSizes.includes(item.value)
                    return (
                      <label className={active ? 'active' : ''} key={item.value}>
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => toggleTestPaperGroupSize(item.value)}
                        />
                        <span>{item.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
              <div className="questionTypeGrid compact">
                {FIXED_TEST_PAPER_SECTIONS.map((item) => (
                  <div className="questionTypeCard compact active fixed" key={item.key}>
                    <strong>{item.title}</strong>
                    {item.needsLlm ? <em>LLM</em> : null}
                    <span>第 {item.order} 题 · {item.countLabel}</span>
                  </div>
                ))}
              </div>
              <p className="genQueueEmpty">按模板固定生成 8 个题段，所选规格共享同一批模型题面，仅在导出时分别分组。当前预计生成 {paperCount} 份 docx{withChineseTranslation ? '' : '（不含中文翻译）'}。</p>
            </>
          ) : (
            <>
              <div className="field fullField">
                <span>每组题目数量（1–500）</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={legacyQuestionCount}
                  onChange={(event) => setLegacyQuestionCount(event.target.value)}
                  onBlur={() => setLegacyQuestionCount(normalizeLegacyQuestionCount(legacyQuestionCount))}
                />
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
              <p className="genQueueEmpty">会按原来的多题型结构打包成 ZIP。当前已勾选 {selectedTypes.length} 个题型，每组生成 {normalizeLegacyQuestionCount(legacyQuestionCount)} 题{withChineseTranslation ? '' : '（不含中文翻译）'}。</p>
            </>
          )}
          <label className="genToggleRow">
            <input
              type="checkbox"
              checked={withChineseTranslation}
              onChange={(event) => setWithChineseTranslation(event.target.checked)}
            />
            <span className="genToggleText">
              <strong>带中文翻译</strong>
              <em>关闭后题面中的中文释义/提示将省略</em>
            </span>
          </label>
        </div>
      </aside>
    </section>
  )
}

export default GenWorkspace
