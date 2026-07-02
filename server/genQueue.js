import crypto from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { generateWorksheetArchive, getDefaultLlmModel } from './genEngine.js'
import { createGetUrl, deleteObject, getObjectJson, listObjects, putObject } from './r2.js'

const JOB_PREFIX = 'worksheet-jobs'
const STALE_PROCESSING_MS = 1000 * 60 * 8
const MAX_LIST_JOBS = 40
const CANCELABLE_STATUSES = new Set(['queued', 'processing', 'canceling'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

let queueLoopPromise = null

const now = () => Date.now()
const jobPrefix = (jobId) => `${JOB_PREFIX}/${jobId}`
const jobStateKey = (jobId) => `${jobPrefix(jobId)}/job.json`
const jobPayloadKey = (jobId) => `${jobPrefix(jobId)}/payload.json`
const jobArtifactKey = (jobId) => `${jobPrefix(jobId)}/artifact.zip`

const summarizeJob = (job) => ({
  id: job.id,
  fileName: job.fileName,
  exportFileName: job.exportFileName || '',
  status: job.status,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  submittedAt: job.submittedAt,
  startedAt: job.startedAt || 0,
  completedAt: job.completedAt || 0,
  failedAt: job.failedAt || 0,
  canceledAt: job.canceledAt || 0,
  wordCount: job.wordCount || 0,
  questionTypes: job.questionTypes || [],
  llmModel: job.llmModel || '',
  progress: job.progress || null,
  error: job.error || '',
  artifactReady: Boolean(job.artifactKey),
  downloadSize: job.downloadSize || 0,
})

const writeJsonObject = async ({ key, value }) => putObject({
  key,
  body: Buffer.from(JSON.stringify(value), 'utf8'),
  contentType: 'application/json; charset=utf-8',
})

const createProgress = (totalSteps, totalWords = 0) => ({
  totalSteps,
  completedSteps: 0,
  currentStep: '',
  message: '已入队，等待服务器处理。',
  percent: 0,
  totalWords,
  stageLabel: '',
  stageWordTotal: 0,
  stageWordCompleted: 0,
  currentQuestionType: '',
})

const buildTotalSteps = (questionTypes) => {
  const needsLexical = questionTypes.some((key) => ['一_释义匹配', '二_选择题', '三_同义替换', '六_同义反义辨析', '七_同义词匹配', '八_反义词匹配', '九_判断正误'].includes(key))
  const needsBasicMaterials = questionTypes.some((key) => ['二_选择题', '九_判断正误'].includes(key))
  const needsSynonymMaterials = questionTypes.includes('三_同义替换')
  return questionTypes.length + (needsLexical ? 1 : 0) + (needsBasicMaterials ? 1 : 0) + (needsSynonymMaterials ? 1 : 0)
}

const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0))
const percentFromSteps = (progress) => (progress.totalSteps
  ? Math.round((progress.completedSteps / progress.totalSteps) * 100)
  : 0)

const progressFromMessage = (job, message) => {
  const progress = {
    ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []), job.wordCount || 0)),
    message,
    currentStep: message,
  }
  const patterns = [
    { regex: /\[.+\] 预热 LLM 词汇关系/i, advance: false },
    { regex: /\[.+\] 预热 LLM 基础题面材料/i, advance: false },
    { regex: /\[.+\] 预热 LLM 同义替换题面材料/i, advance: false },
  ]
  for (const pattern of patterns) {
    if (pattern.regex.test(message)) {
      if (!pattern.advance) {
        progress.percent = percentFromSteps(progress)
      }
      return progress
    }
  }
  if (/\[.+\] 开始生成 /.test(message)) {
    progress.percent = percentFromSteps(progress)
    return progress
  }
  if (/^\s*✓ /.test(message)) {
    progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + 1)
    progress.percent = percentFromSteps(progress)
    return progress
  }
  if (/预热 LLM 词汇关系|预热 LLM 基础题面材料|预热 LLM 同义替换题面材料/.test(message)) {
    progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + 1)
    progress.percent = percentFromSteps(progress)
  }
  return progress
}

const progressFromEvent = (job, event) => {
  if (!event || typeof event === 'string') return progressFromMessage(job, String(event || ''))
  const progress = {
    ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []), job.wordCount || 0)),
  }

  if (typeof event.message === 'string') progress.message = event.message
  if (typeof event.currentStep === 'string') progress.currentStep = event.currentStep
  if (typeof event.stageLabel === 'string') progress.stageLabel = event.stageLabel
  if (typeof event.currentQuestionType === 'string') progress.currentQuestionType = event.currentQuestionType
  if (Number.isFinite(event.totalWords)) progress.totalWords = Math.max(0, Number(event.totalWords) || 0)
  if (Number.isFinite(event.stageWordTotal)) progress.stageWordTotal = Math.max(0, Number(event.stageWordTotal) || 0)
  if (Number.isFinite(event.stageWordCompleted)) {
    progress.stageWordCompleted = Math.max(0, Number(event.stageWordCompleted) || 0)
  }
  if (Number.isFinite(event.totalSteps)) progress.totalSteps = Math.max(0, Number(event.totalSteps) || 0)
  if (Number.isFinite(event.completedSteps)) {
    progress.completedSteps = Math.max(0, Math.min(progress.totalSteps || Number(event.completedSteps), Number(event.completedSteps) || 0))
  }
  if (Number.isFinite(event.stepDelta)) {
    progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + (Number(event.stepDelta) || 0))
  }
  progress.percent = Number.isFinite(event.percent) ? clampPercent(event.percent) : percentFromSteps(progress)
  return progress
}

const readJob = async (jobId) => getObjectJson({ key: jobStateKey(jobId) })
const readJobPayload = async (jobId) => getObjectJson({ key: jobPayloadKey(jobId) })

const writeJob = async (job) => {
  const nextJob = {
    ...job,
    updatedAt: now(),
  }
  await writeJsonObject({ key: jobStateKey(job.id), value: nextJob })
  return nextJob
}

const readLatestJobState = async (jobId) => readJob(jobId).catch(() => null)

const settleStaleCanceledJobs = async (jobs) => Promise.all((jobs || []).map(async (job) => {
  if (job?.status !== 'canceling') return job
  if (now() - Number(job.updatedAt || 0) <= STALE_PROCESSING_MS) return job
  return writeJob({
    ...job,
    status: 'canceled',
    canceledAt: job.canceledAt || now(),
    error: '',
    progress: {
      ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []), job.wordCount || 0)),
      currentStep: '已取消',
      message: '任务已取消。',
    },
  })
}))

const listJobStates = async () => {
  const objects = await listObjects({ prefix: `${JOB_PREFIX}/` })
  const jobKeys = objects
    .map((item) => item.Key)
    .filter((key) => key?.endsWith('/job.json'))
  const jobs = await Promise.all(jobKeys.map((key) => getObjectJson({ key }).catch(() => null)))
  const normalizedJobs = await settleStaleCanceledJobs(jobs.filter(Boolean))
  return normalizedJobs
    .filter(Boolean)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .slice(0, MAX_LIST_JOBS)
}

const findNextProcessableJob = async () => {
  const jobs = await listJobStates()
  const candidate = jobs
    .filter((job) => job.status === 'queued' || (job.status === 'processing' && now() - Number(job.updatedAt || 0) > STALE_PROCESSING_MS))
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))[0]
  return candidate || null
}

const processSingleJob = async (job) => {
  if (!job || TERMINAL_STATUSES.has(job.status) || job.status === 'canceling') return
  const latestJob = await readLatestJobState(job.id)
  if (!latestJob || TERMINAL_STATUSES.has(latestJob.status) || latestJob.status === 'canceling') return
  const payload = await readJobPayload(job.id).catch(() => null)
  if (!payload) return
  let liveJob = await writeJob({
    ...latestJob,
    status: 'processing',
    startedAt: latestJob.startedAt || now(),
    error: '',
  })
  const ensureNotCanceled = async () => {
    const latestJob = await readLatestJobState(job.id)
    if (latestJob && ['canceling', 'canceled'].includes(latestJob.status)) {
      const error = new Error('任务已取消。')
      error.code = 'JOB_CANCELED'
      throw error
    }
  }

  try {
    await ensureNotCanceled()
    const result = await generateWorksheetArchive({
      rows: payload.rows || [],
      fileName: payload.fileName || '词组练习.xlsx',
      questionTypes: payload.questionTypes || latestJob.questionTypes,
      llmModel: payload.llmModel || latestJob.llmModel || getDefaultLlmModel(),
      onProgress: async (event) => {
        await ensureNotCanceled()
        liveJob = await writeJob({
          ...liveJob,
          progress: progressFromEvent(liveJob, event),
        })
      },
      onShouldCancel: async () => {
        const latestJob = await readLatestJobState(job.id)
        return Boolean(latestJob && ['canceling', 'canceled'].includes(latestJob.status))
      },
    })

    await ensureNotCanceled()
    const artifactKey = jobArtifactKey(job.id)
    await putObject({
      key: artifactKey,
      body: result.buffer,
      contentType: 'application/zip',
    })

    await writeJob({
      ...liveJob,
      status: 'completed',
      completedAt: now(),
      artifactKey,
      exportFileName: result.fileName,
      wordCount: result.wordCount,
      downloadSize: result.buffer.length,
      progress: {
        ...(liveJob.progress || createProgress(buildTotalSteps(latestJob.questionTypes || []), latestJob.wordCount || 0)),
        completedSteps: buildTotalSteps(latestJob.questionTypes || []),
        currentStep: '打包完成',
        message: '已完成',
        percent: 100,
        stageLabel: '打包完成',
        stageWordTotal: latestJob.wordCount || result.wordCount || 0,
        stageWordCompleted: latestJob.wordCount || result.wordCount || 0,
      },
    })
  } catch (error) {
    if (error?.code === 'JOB_CANCELED') {
      const latestJob = await readLatestJobState(job.id)
      await writeJob({
        ...(latestJob || liveJob),
        status: 'canceled',
        canceledAt: now(),
        error: '',
        progress: {
          ...((latestJob && latestJob.progress) || liveJob.progress || createProgress(buildTotalSteps((latestJob && latestJob.questionTypes) || job.questionTypes || []), (latestJob && latestJob.wordCount) || job.wordCount || 0)),
          currentStep: '已取消',
          message: '任务已取消。',
        },
      })
      return
    }
    await writeJob({
      ...liveJob,
      status: 'failed',
      failedAt: now(),
      error: error.message || '生成失败。',
      progress: {
        ...(liveJob.progress || createProgress(buildTotalSteps(latestJob.questionTypes || []), latestJob.wordCount || 0)),
        message: error.message || '生成失败。',
      },
    })
  }
}

const processQueueLoop = async () => {
  while (true) {
    const nextJob = await findNextProcessableJob()
    if (!nextJob) return
    await processSingleJob(nextJob)
  }
}

export const kickWorksheetJobQueue = async () => {
  if (queueLoopPromise) return queueLoopPromise
  queueLoopPromise = processQueueLoop().finally(() => {
    queueLoopPromise = null
  })
  return queueLoopPromise
}

export const scheduleWorksheetJobQueue = () => {
  waitUntil(kickWorksheetJobQueue())
}

export const submitWorksheetJob = async ({ rows, fileName, questionTypes, llmModel }) => {
  const id = crypto.randomUUID()
  const submittedAt = now()
  const totalSteps = buildTotalSteps(questionTypes)
  const job = {
    id,
    fileName: String(fileName || '词组练习.xlsx'),
    questionTypes,
    llmModel: String(llmModel || getDefaultLlmModel()).trim(),
    createdAt: submittedAt,
    submittedAt,
    updatedAt: submittedAt,
    status: 'queued',
    wordCount: Array.isArray(rows) ? rows.length : 0,
    progress: createProgress(totalSteps, Array.isArray(rows) ? rows.length : 0),
    error: '',
    artifactKey: '',
    exportFileName: '',
    downloadSize: 0,
  }

  await Promise.all([
    writeJsonObject({
      key: jobPayloadKey(id),
      value: {
        rows,
        fileName: job.fileName,
        questionTypes,
        llmModel: job.llmModel,
      },
    }),
    writeJsonObject({
      key: jobStateKey(id),
      value: job,
    }),
  ])

  return summarizeJob(job)
}

export const listWorksheetJobs = async () => {
  const jobs = await listJobStates()
  return jobs.map(summarizeJob)
}

export const getWorksheetJob = async (jobId) => summarizeJob(await readJob(jobId))

export const cancelWorksheetJob = async (jobId) => {
  const job = await readJob(jobId)
  if (!job) {
    const error = new Error('未找到对应任务。')
    error.statusCode = 404
    throw error
  }

  if (!CANCELABLE_STATUSES.has(job.status)) return summarizeJob(job)

  if (job.status === 'queued') {
    const canceledJob = await writeJob({
      ...job,
      status: 'canceled',
      canceledAt: now(),
      error: '',
      progress: {
        ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []), job.wordCount || 0)),
        currentStep: '已取消',
        message: '任务已取消。',
      },
    })
    return summarizeJob(canceledJob)
  }

  const cancelingJob = await writeJob({
    ...job,
    status: 'canceling',
    error: '',
    progress: {
      ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []), job.wordCount || 0)),
      currentStep: '正在停止',
      message: '正在停止任务，请等待最后一次调用完成…',
    },
  })
  return summarizeJob(cancelingJob)
}

export const deleteWorksheetJob = async (jobId) => {
  const job = await readJob(jobId).catch(() => null)
  if (!job) return { ok: true }
  if (['processing', 'canceling'].includes(job.status)) {
    const error = new Error('请先停止该任务，再删除记录。')
    error.statusCode = 409
    throw error
  }

  const keys = await listObjects({ prefix: `${jobPrefix(jobId)}/` })
  await Promise.all(keys.map((item) => deleteObject({ key: item.Key }).catch(() => null)))
  return { ok: true }
}

export const getWorksheetJobDownload = async (jobId) => {
  const job = await readJob(jobId)
  if (job.status !== 'completed' || !job.artifactKey) {
    const error = new Error('该任务尚未生成完成。')
    error.statusCode = 409
    throw error
  }
  const url = await createGetUrl({ key: job.artifactKey, expiresIn: 60 * 10 })
  const response = await fetch(url)
  if (!response.ok) {
    const error = new Error('未找到已生成的练习包。')
    error.statusCode = 404
    throw error
  }
  return {
    job: summarizeJob(job),
    buffer: Buffer.from(await response.arrayBuffer()),
  }
}
