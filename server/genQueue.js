import crypto from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { generateWorksheetArchive, getDefaultLlmModel, getLlmJobRuntime } from './genEngine.js'
import { deleteObject, getObjectBuffer, getObjectJson, listObjects, putObject } from './r2.js'

const JOB_PREFIX = 'worksheet-jobs'
const STALE_PROCESSING_MS = 1000 * 60 * 8
const MAX_LIST_JOBS = 40
const PROGRESS_WRITE_INTERVAL_MS = Math.max(200, Number.parseInt(process.env.GEN_QUEUE_PROGRESS_WRITE_INTERVAL_MS || '700', 10) || 700)
const PROGRESS_WRITE_WORD_DELTA = Math.max(1, Number.parseInt(process.env.GEN_QUEUE_PROGRESS_WRITE_WORD_DELTA || '5', 10) || 5)
const CANCELLATION_POLL_INTERVAL_MS = Math.max(150, Number.parseInt(process.env.GEN_QUEUE_CANCELLATION_POLL_INTERVAL_MS || '300', 10) || 300)
const MAX_INTERNAL_QUEUE_WAIT_MS = Math.max(1000, Number.parseInt(process.env.GEN_QUEUE_MAX_INTERNAL_WAIT_MS || '45000', 10) || 45000)
const MIN_RATE_LIMIT_DELAY_MS = Math.max(1000, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MIN_DELAY_MS || '10000', 10) || 10000)
const MAX_RATE_LIMIT_DELAY_MS = Math.max(MIN_RATE_LIMIT_DELAY_MS, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MAX_DELAY_MS || '120000', 10) || 120000)
const MAX_RATE_LIMIT_REQUEUES = Math.max(1, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MAX_REQUEUES || '8', 10) || 8)
const CANCELABLE_STATUSES = new Set(['queued', 'processing', 'canceling'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

let queueLoopPromise = null

const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
  llmBatchSize: job.llmBatchSize || 0,
  llmConcurrency: job.llmConcurrency || 0,
  llmRateLimitRetries: job.llmRateLimitRetries || 0,
  nextAttemptAt: job.nextAttemptAt || 0,
  reuseLlmCache: job.reuseLlmCache !== false,
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

const buildLlmRuntimeForJob = (job = {}) => {
  const runtime = getLlmJobRuntime(job.llmModel || getDefaultLlmModel(), {
    batchSize: job.llmBatchSize,
    concurrency: job.llmConcurrency,
  })
  const storedFallbacks = Array.isArray(job.llmFallbackModels)
    ? job.llmFallbackModels.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  return {
    model: runtime.model,
    batchSize: runtime.batchSize,
    concurrency: runtime.concurrency,
    fallbackModels: storedFallbacks.length ? storedFallbacks : runtime.fallbackModels,
  }
}

const computeRateLimitDelayMs = (error, retryCount) => {
  const headerDelay = Math.max(0, Number(error?.retryAfterMs || 0))
  const exponentialDelay = Math.min(MAX_RATE_LIMIT_DELAY_MS, MIN_RATE_LIMIT_DELAY_MS * (2 ** Math.min(5, Math.max(0, retryCount))))
  const baseDelay = Math.max(MIN_RATE_LIMIT_DELAY_MS, headerDelay, exponentialDelay)
  const jitter = Math.min(1500, Math.round(baseDelay * 0.12 * Math.random()))
  return Math.min(MAX_RATE_LIMIT_DELAY_MS, baseDelay + jitter)
}

const tuneLlmRuntimeAfterRateLimit = (job = {}) => {
  const current = buildLlmRuntimeForJob(job)
  if (current.concurrency > 1) {
    return {
      llmModel: current.model,
      llmBatchSize: current.batchSize,
      llmConcurrency: current.concurrency - 1,
      llmFallbackModels: current.fallbackModels,
      reason: `降低并发到 ${current.concurrency - 1}`,
    }
  }
  if (current.batchSize > 1) {
    return {
      llmModel: current.model,
      llmBatchSize: Math.max(1, Math.floor(current.batchSize / 2)),
      llmConcurrency: current.concurrency,
      llmFallbackModels: current.fallbackModels,
      reason: `降低批次到 ${Math.max(1, Math.floor(current.batchSize / 2))}`,
    }
  }
  if (current.fallbackModels.length) {
    const [nextModel, ...remainingFallbacks] = current.fallbackModels
    const nextRuntime = getLlmJobRuntime(nextModel)
    return {
      llmModel: nextRuntime.model,
      llmBatchSize: nextRuntime.batchSize,
      llmConcurrency: nextRuntime.concurrency,
      llmFallbackModels: remainingFallbacks,
      reason: `切换备用模型 ${nextRuntime.model}`,
    }
  }
  return {
    llmModel: current.model,
    llmBatchSize: current.batchSize,
    llmConcurrency: current.concurrency,
    llmFallbackModels: current.fallbackModels,
    reason: '等待限流恢复',
  }
}

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
  const currentTime = now()
  const candidate = jobs
    .filter((job) => (
      (job.status === 'queued' && currentTime >= Number(job.nextAttemptAt || 0))
      || (job.status === 'processing' && currentTime - Number(job.updatedAt || 0) > STALE_PROCESSING_MS)
    ))
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))[0]
  if (candidate) return { job: candidate, waitMs: 0 }

  const nextDelayedJob = jobs
    .filter((job) => job.status === 'queued' && Number(job.nextAttemptAt || 0) > currentTime)
    .sort((left, right) => Number(left.nextAttemptAt || 0) - Number(right.nextAttemptAt || 0))[0]
  return {
    job: null,
    waitMs: nextDelayedJob ? Math.max(0, Number(nextDelayedJob.nextAttemptAt || 0) - currentTime) : 0,
  }
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
    nextAttemptAt: 0,
    error: '',
  })
  let lastPersistedProgress = liveJob.progress || null
  let lastProgressWriteAt = now()
  let cancelKnown = false
  let lastCancelCheckAt = 0

  const shouldCancel = async (force = false) => {
    if (cancelKnown) return true
    const elapsed = now() - lastCancelCheckAt
    if (!force && lastCancelCheckAt && elapsed < CANCELLATION_POLL_INTERVAL_MS) return false
    lastCancelCheckAt = now()
    const currentJob = await readLatestJobState(job.id)
    cancelKnown = Boolean(currentJob && ['canceling', 'canceled'].includes(currentJob.status))
    return cancelKnown
  }

  const ensureNotCanceled = async (force = false) => {
    if (await shouldCancel(force)) {
      const error = new Error('任务已取消。')
      error.code = 'JOB_CANCELED'
      throw error
    }
  }

  const persistProgress = async (nextProgress, force = false) => {
    liveJob = {
      ...liveJob,
      progress: nextProgress,
    }
    const previous = lastPersistedProgress || {}
    const stageChanged =
      (nextProgress?.currentStep || '') !== (previous.currentStep || '') ||
      (nextProgress?.stageLabel || '') !== (previous.stageLabel || '') ||
      (nextProgress?.currentQuestionType || '') !== (previous.currentQuestionType || '')
    const stageWordDelta = Math.abs(Number(nextProgress?.stageWordCompleted || 0) - Number(previous.stageWordCompleted || 0))
    const completedStepDelta = Math.abs(Number(nextProgress?.completedSteps || 0) - Number(previous.completedSteps || 0))
    const intervalElapsed = now() - lastProgressWriteAt >= PROGRESS_WRITE_INTERVAL_MS
    const shouldFlush =
      force ||
      !lastPersistedProgress ||
      stageChanged ||
      stageWordDelta >= PROGRESS_WRITE_WORD_DELTA ||
      completedStepDelta >= 1 ||
      intervalElapsed ||
      Number(nextProgress?.percent || 0) >= 100

    if (!shouldFlush) return
    liveJob = await writeJob(liveJob)
    lastPersistedProgress = liveJob.progress || nextProgress
    lastProgressWriteAt = now()
  }

  try {
    await ensureNotCanceled(true)
    const result = await generateWorksheetArchive({
      rows: payload.rows || [],
      fileName: payload.fileName || '词组练习.xlsx',
      questionTypes: payload.questionTypes || latestJob.questionTypes,
      llmModel: payload.llmModel || latestJob.llmModel || getDefaultLlmModel(),
      llmBatchSize: payload.llmBatchSize || latestJob.llmBatchSize,
      llmConcurrency: payload.llmConcurrency || latestJob.llmConcurrency,
      reuseLlmCache: payload.reuseLlmCache !== false && latestJob.reuseLlmCache !== false,
      onProgress: async (event) => {
        await persistProgress(progressFromEvent(liveJob, event))
      },
      onShouldCancel: shouldCancel,
    })

    await ensureNotCanceled(true)
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
      nextAttemptAt: 0,
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
        nextAttemptAt: 0,
        error: '',
        progress: {
          ...((latestJob && latestJob.progress) || liveJob.progress || createProgress(buildTotalSteps((latestJob && latestJob.questionTypes) || job.questionTypes || []), (latestJob && latestJob.wordCount) || job.wordCount || 0)),
          currentStep: '已取消',
          message: '任务已取消。',
        },
      })
      return
    }
    if (error?.code === 'LLM_RATE_LIMITED') {
      const latestJobForRetry = await readLatestJobState(job.id)
      if (latestJobForRetry && ['canceling', 'canceled'].includes(latestJobForRetry.status)) {
        await writeJob({
          ...latestJobForRetry,
          status: 'canceled',
          canceledAt: latestJobForRetry.canceledAt || now(),
          nextAttemptAt: 0,
          error: '',
          progress: {
            ...(latestJobForRetry.progress || createProgress(buildTotalSteps(latestJobForRetry.questionTypes || []), latestJobForRetry.wordCount || 0)),
            currentStep: '已取消',
            message: '任务已取消。',
          },
        })
        return
      }
      const retryBaseJob = {
        ...(latestJobForRetry || liveJob),
        questionTypes: (latestJobForRetry && latestJobForRetry.questionTypes) || liveJob.questionTypes || job.questionTypes || [],
        wordCount: (latestJobForRetry && latestJobForRetry.wordCount) || liveJob.wordCount || job.wordCount || 0,
      }
      const retryCount = Math.max(0, Number(retryBaseJob.llmRateLimitRetries || 0))
      if (retryCount >= MAX_RATE_LIMIT_REQUEUES) {
        await writeJob({
          ...retryBaseJob,
          status: 'failed',
          failedAt: now(),
          error: `LLM 请求连续触发限流，已达到最大自动重试次数（${MAX_RATE_LIMIT_REQUEUES}）。`,
          progress: {
            ...(retryBaseJob.progress || createProgress(buildTotalSteps(retryBaseJob.questionTypes || []), retryBaseJob.wordCount || 0)),
            currentStep: '限流重试失败',
            message: `LLM 请求连续触发限流，已达到最大自动重试次数（${MAX_RATE_LIMIT_REQUEUES}）。`,
          },
        })
        return
      }

      const runtimeUpdate = tuneLlmRuntimeAfterRateLimit(retryBaseJob)
      const delayMs = computeRateLimitDelayMs(error, retryCount)
      const nextAttemptAt = now() + delayMs
      const waitingMessage = `LLM 触发限流，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后自动重试；${runtimeUpdate.reason}。`
      const queuedRetryJob = await writeJob({
        ...retryBaseJob,
        status: 'queued',
        error: '',
        llmModel: runtimeUpdate.llmModel,
        llmBatchSize: runtimeUpdate.llmBatchSize,
        llmConcurrency: runtimeUpdate.llmConcurrency,
        llmFallbackModels: runtimeUpdate.llmFallbackModels,
        llmRateLimitRetries: retryCount + 1,
        nextAttemptAt,
        progress: {
          ...(retryBaseJob.progress || createProgress(buildTotalSteps(retryBaseJob.questionTypes || []), retryBaseJob.wordCount || 0)),
          currentStep: '等待限流恢复',
          stageLabel: '等待限流恢复',
          message: waitingMessage,
        },
      })
      await writeJsonObject({
        key: jobPayloadKey(job.id),
        value: {
          ...(payload || {}),
          rows: payload?.rows || [],
          fileName: payload?.fileName || queuedRetryJob.fileName,
          questionTypes: payload?.questionTypes || queuedRetryJob.questionTypes,
          llmModel: queuedRetryJob.llmModel,
          llmBatchSize: queuedRetryJob.llmBatchSize,
          llmConcurrency: queuedRetryJob.llmConcurrency,
          llmFallbackModels: queuedRetryJob.llmFallbackModels || [],
          reuseLlmCache: queuedRetryJob.reuseLlmCache !== false,
        },
      })
      return
    }
    await writeJob({
      ...liveJob,
      status: 'failed',
      failedAt: now(),
      nextAttemptAt: 0,
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
    const { job: nextJob, waitMs } = await findNextProcessableJob()
    if (!nextJob) {
      if (!waitMs || waitMs > MAX_INTERNAL_QUEUE_WAIT_MS) return
      await sleep(waitMs)
      continue
    }
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

export const submitWorksheetJob = async ({ rows, fileName, questionTypes, llmModel, reuseLlmCache = true }) => {
  const id = crypto.randomUUID()
  const submittedAt = now()
  const totalSteps = buildTotalSteps(questionTypes)
  const llmRuntime = getLlmJobRuntime(String(llmModel || getDefaultLlmModel()).trim())
  const job = {
    id,
    fileName: String(fileName || '词组练习.xlsx'),
    questionTypes,
    llmModel: llmRuntime.model,
    llmFallbackModels: llmRuntime.fallbackModels,
    llmBatchSize: llmRuntime.batchSize,
    llmConcurrency: llmRuntime.concurrency,
    llmRateLimitRetries: 0,
    nextAttemptAt: 0,
    reuseLlmCache: reuseLlmCache !== false,
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
        llmFallbackModels: job.llmFallbackModels,
        llmBatchSize: job.llmBatchSize,
        llmConcurrency: job.llmConcurrency,
        reuseLlmCache: job.reuseLlmCache,
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
      nextAttemptAt: 0,
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
    nextAttemptAt: 0,
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
  return {
    job: summarizeJob(job),
    buffer: await getObjectBuffer({ key: job.artifactKey }),
  }
}
