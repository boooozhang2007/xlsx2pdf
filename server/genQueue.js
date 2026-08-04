import crypto from 'node:crypto'
import { generateWorksheetArchive, getDefaultLlmModel, getLlmJobRuntime } from './genEngine.js'
import { deleteObject, getObjectBuffer, getObjectJson, getObjectJsonWithMetadata, listObjects, putObject } from './r2.js'
import {
  GENERATION_MODE_FIXED_TEST_PAPER,
  GENERATION_MODE_LEGACY_ZIP,
  normalizeLegacyQuestionCount,
  normalizeTestPaperGroupSizes,
  normalizeWithChineseTranslation,
} from '../shared/generationModes.js'

const JOB_PREFIX = 'worksheet-jobs'
const STALE_PROCESSING_MS = Math.max(60_000, Number.parseInt(process.env.GEN_QUEUE_STALE_PROCESSING_MS || '360000', 10) || 360_000)
const MAX_LIST_JOBS = 40
const PROGRESS_WRITE_INTERVAL_MS = Math.max(200, Number.parseInt(process.env.GEN_QUEUE_PROGRESS_WRITE_INTERVAL_MS || '700', 10) || 700)
const PROGRESS_WRITE_WORD_DELTA = Math.max(1, Number.parseInt(process.env.GEN_QUEUE_PROGRESS_WRITE_WORD_DELTA || '5', 10) || 5)
const RENDER_PROGRESS_WRITE_INTERVAL_MS = Math.max(PROGRESS_WRITE_INTERVAL_MS, 5000)
const RENDER_PROGRESS_WRITE_WORD_DELTA = Math.max(PROGRESS_WRITE_WORD_DELTA, 200)
const CANCELLATION_POLL_INTERVAL_MS = Math.max(150, Number.parseInt(process.env.GEN_QUEUE_CANCELLATION_POLL_INTERVAL_MS || '300', 10) || 300)
const LLM_ENTRIES_PER_STEP = Math.max(1, Number.parseInt(process.env.GEN_QUEUE_LLM_ENTRIES_PER_STEP || '100', 10) || 100)
const LLM_BATCH_ROUNDS_PER_STEP = Math.max(1, Number.parseInt(process.env.GEN_QUEUE_LLM_BATCH_ROUNDS_PER_STEP || '3', 10) || 3)
const WORKFLOW_STEP_SOFT_LIMIT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.GEN_QUEUE_WORKFLOW_STEP_SOFT_LIMIT_MS || '180000', 10) || 180_000,
)
const MAX_INTERNAL_QUEUE_WAIT_MS = Math.max(1000, Number.parseInt(process.env.GEN_QUEUE_MAX_INTERNAL_WAIT_MS || '45000', 10) || 45000)
const MIN_RATE_LIMIT_DELAY_MS = Math.max(1000, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MIN_DELAY_MS || '10000', 10) || 10000)
const MAX_RATE_LIMIT_DELAY_MS = Math.max(MIN_RATE_LIMIT_DELAY_MS, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MAX_DELAY_MS || '120000', 10) || 120000)
const MAX_RATE_LIMIT_REQUEUES = Math.max(1, Number.parseInt(process.env.VIVI_LLM_RATE_LIMIT_MAX_REQUEUES || '8', 10) || 8)
const MAX_REQUEST_REQUEUES = Math.max(1, Number.parseInt(process.env.VIVI_LLM_REQUEST_MAX_REQUEUES || '8', 10) || 8)
const MIN_REQUEST_RECOVERY_WAIT_MS = Math.max(
  MAX_INTERNAL_QUEUE_WAIT_MS,
  Number.parseInt(process.env.VIVI_LLM_REQUEST_RECOVERY_MIN_DELAY_MS || '300000', 10) || 300_000,
)
const MAX_REQUEST_RECOVERY_WAIT_MS = Math.max(
  MIN_REQUEST_RECOVERY_WAIT_MS,
  Number.parseInt(process.env.VIVI_LLM_REQUEST_RECOVERY_MAX_DELAY_MS || '900000', 10) || 900_000,
)
const VALIDATION_RETRY_DELAY_MS = Math.max(
  1000,
  Number.isFinite(Number.parseInt(process.env.VIVI_LLM_VALIDATION_RETRY_DELAY_MS || '3000', 10))
    ? Number.parseInt(process.env.VIVI_LLM_VALIDATION_RETRY_DELAY_MS || '3000', 10)
    : 3000,
)
const MAX_VALIDATION_REQUEUES = Math.max(
  0,
  Number.isFinite(Number.parseInt(process.env.VIVI_LLM_VALIDATION_MAX_REQUEUES || '2', 10))
    ? Number.parseInt(process.env.VIVI_LLM_VALIDATION_MAX_REQUEUES || '2', 10)
    : 2,
)
const CANCELABLE_STATUSES = new Set(['queued', 'processing', 'canceling'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled'])

const now = () => Date.now()
const jobPrefix = (jobId) => `${JOB_PREFIX}/${jobId}`
const jobStateKey = (jobId) => `${jobPrefix(jobId)}/job.json`
const jobPayloadKey = (jobId) => `${jobPrefix(jobId)}/payload.json`
const jobArtifactKey = (jobId) => `${jobPrefix(jobId)}/artifact.zip`
const jobCacheKey = (jobId) => `${jobPrefix(jobId)}/cache.json`
const normalizeGenerationMode = (mode) => (mode === GENERATION_MODE_LEGACY_ZIP ? GENERATION_MODE_LEGACY_ZIP : GENERATION_MODE_FIXED_TEST_PAPER)

const buildJobFingerprint = ({
  rows,
  fileName,
  questionTypes,
  generationMode,
  llmModel,
  legacyQuestionCount,
  testPaperGroupSizes,
  withChineseTranslation,
}) => crypto.createHash('sha256').update(JSON.stringify({
  rows,
  fileName,
  questionTypes,
  generationMode,
  llmModel,
  legacyQuestionCount,
  testPaperGroupSizes,
  withChineseTranslation,
})).digest('hex')

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
  generationMode: normalizeGenerationMode(job.generationMode),
  legacyQuestionCount: normalizeLegacyQuestionCount(job.legacyQuestionCount),
  testPaperGroupSizes: normalizeTestPaperGroupSizes(job.testPaperGroupSizes),
  withChineseTranslation: normalizeWithChineseTranslation(job.withChineseTranslation),
  llmModel: job.llmModel || '',
  llmBatchSize: job.llmBatchSize || 0,
  llmConcurrency: job.llmConcurrency || 0,
  llmRateLimitRetries: job.llmRateLimitRetries || 0,
  llmValidationRetries: job.llmValidationRetries || 0,
  llmRequestRetries: job.llmRequestRetries || 0,
  lastLlmError: job.lastLlmError || '',
  nextAttemptAt: job.nextAttemptAt || 0,
  progress: job.progress || null,
  error: job.error || '',
  artifactReady: Boolean(job.artifactKey),
  downloadSize: job.downloadSize || 0,
  batchId: job.batchId || '',
  copyIndex: job.copyIndex || 0,
  copyCount: job.copyCount || 1,
})

const writeJsonObject = async ({ key, value, ifMatch, ifNoneMatch }) => putObject({
  key,
  body: Buffer.from(JSON.stringify(value), 'utf8'),
  contentType: 'application/json; charset=utf-8',
  ifMatch,
  ifNoneMatch,
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
  completedStepKeys: [],
  inProgressSteps: 0,
})

const resetJobProgress = (job, overrides = {}) => ({
  ...createProgress(
    buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode, job.testPaperGroupSizes),
    job.wordCount || 0,
  ),
  ...overrides,
})

const buildTotalSteps = (questionTypes, wordCount = 0, generationMode = GENERATION_MODE_FIXED_TEST_PAPER, testPaperGroupSizes = [100]) => {
  const needsLexical = questionTypes.some((key) => ['一_释义匹配', '三_同义替换', '六_同义反义辨析', '七_同义词匹配', '八_反义词匹配'].includes(key))
  const needsBasicMaterials = questionTypes.some((key) => ['二_选择题', '九_判断正误'].includes(key))
  const needsSynonymMaterials = questionTypes.includes('三_同义替换')
  const paperCount = normalizeGenerationMode(generationMode) === GENERATION_MODE_FIXED_TEST_PAPER
    ? normalizeTestPaperGroupSizes(testPaperGroupSizes).reduce((total, size) => (
        total + Math.max(1, Math.ceil((Number(wordCount) || 0) / (size || Math.max(1, Number(wordCount) || 1))))
      ), 0)
    : questionTypes.length
  return paperCount + (needsLexical ? 1 : 0) + (needsBasicMaterials ? 1 : 0) + (needsSynonymMaterials ? 1 : 0)
}

const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0))
const percentFromSteps = (progress) => (progress.totalSteps
  ? Math.round(((progress.completedSteps + Math.max(0, Number(progress.inProgressSteps || 0))) / progress.totalSteps) * 100)
  : 0)

const progressFromMessage = (job, message) => {
  const progress = {
    ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode), job.wordCount || 0)),
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

export const progressFromEvent = (job, event) => {
  if (!event || typeof event === 'string') return progressFromMessage(job, String(event || ''))
  const previousProgress = job.progress || createProgress(
    buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode),
    job.wordCount || 0,
  )
  const progress = {
    ...previousProgress,
    completedStepKeys: Array.isArray(previousProgress.completedStepKeys) ? [...previousProgress.completedStepKeys] : [],
  }

  if (typeof event.message === 'string') progress.message = event.message
  if (typeof event.currentStep === 'string') progress.currentStep = event.currentStep
  if (typeof event.stageLabel === 'string') progress.stageLabel = event.stageLabel
  if (typeof event.currentQuestionType === 'string') progress.currentQuestionType = event.currentQuestionType
  if (Number.isFinite(event.totalWords)) progress.totalWords = Math.max(0, Number(event.totalWords) || 0)
  if (Number.isFinite(event.stageWordTotal)) progress.stageWordTotal = Math.max(0, Number(event.stageWordTotal) || 0)
  if (Number.isFinite(event.stageWordCompleted)) {
    const nextCompleted = Math.max(0, Number(event.stageWordCompleted) || 0)
    const sameStage = event.stageLabel && previousProgress.stageLabel
      ? event.stageLabel === previousProgress.stageLabel
      : (!event.currentStep || event.currentStep === previousProgress.currentStep)
    progress.stageWordCompleted = sameStage
      ? Math.max(Number(progress.stageWordCompleted || 0), nextCompleted)
      : nextCompleted
  }
  if (Number.isFinite(event.totalSteps)) progress.totalSteps = Math.max(0, Number(event.totalSteps) || 0)
  if (Number.isFinite(event.completedSteps)) {
    progress.completedSteps = Math.max(
      Number(previousProgress.completedSteps || 0),
      Math.max(0, Math.min(progress.totalSteps || Number(event.completedSteps), Number(event.completedSteps) || 0)),
    )
  }
  if (Number.isFinite(event.stepDelta)) {
    const stepKey = String(event.stepKey || '').trim()
    if (!stepKey || !progress.completedStepKeys.includes(stepKey)) {
      progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + (Number(event.stepDelta) || 0))
      if (stepKey) progress.completedStepKeys.push(stepKey)
    }
  }
  if (Number.isFinite(event.inProgressSteps)) {
    const requestedInProgress = Math.max(0, Number(event.inProgressSteps) || 0)
    const inProgressStepKeys = Array.isArray(event.inProgressStepKeys)
      ? event.inProgressStepKeys.map((key) => String(key || '').trim()).filter(Boolean)
      : []
    const pendingStepCount = inProgressStepKeys.filter((key) => !progress.completedStepKeys.includes(key)).length
    progress.inProgressSteps = inProgressStepKeys.length
      ? Math.min(requestedInProgress, pendingStepCount)
      : requestedInProgress
  }
  const nextPercent = Number.isFinite(event.percent) ? clampPercent(event.percent) : percentFromSteps(progress)
  progress.percent = Math.max(clampPercent(previousProgress.percent), nextPercent)
  return progress
}

const readJob = async (jobId) => getObjectJson({ key: jobStateKey(jobId) })
const readJobWithMetadata = async (jobId) => getObjectJsonWithMetadata({ key: jobStateKey(jobId) })
const readJobPayload = async (jobId) => getObjectJson({ key: jobPayloadKey(jobId) })

const writeJob = async (job) => {
  const nextJob = {
    ...job,
    updatedAt: now(),
  }
  await writeJsonObject({ key: jobStateKey(job.id), value: nextJob })
  return nextJob
}

const writeOwnedJob = async (job, etag) => {
  if (!etag) throw new Error('R2 未返回任务状态 ETag，无法安全接管任务。')
  const nextJob = {
    ...job,
    updatedAt: now(),
  }
  try {
    const response = await writeJsonObject({
      key: jobStateKey(job.id),
      value: nextJob,
      ifMatch: etag,
    })
    if (!response.ETag) throw new Error('R2 条件写入未返回 ETag，已停止执行以避免重复任务。')
    return { job: nextJob, etag: response.ETag }
  } catch (cause) {
    if (cause?.$metadata?.httpStatusCode === 412 || cause?.name === 'PreconditionFailed') {
      const error = new Error('任务已由其他执行器或取消操作接管。')
      error.code = 'JOB_OWNERSHIP_LOST'
      error.cause = cause
      throw error
    }
    throw cause
  }
}

const readLatestJobState = async (jobId) => readJob(jobId).catch(() => null)

const getLlmRetryProgressMark = (job = {}, { includeStage = false } = {}) => {
  const progress = job.progress || {}
  const mark = [
    Number(progress.completedSteps || 0),
    Array.isArray(progress.completedStepKeys) ? progress.completedStepKeys.length : 0,
    Number(progress.stageWordCompleted || 0),
  ]
  if (includeStage) mark.push(String(progress.stageLabel || progress.currentStep || ''))
  return mark.join(':')
}

export const getLlmRequestRetryState = (job = {}) => {
  const progressMark = getLlmRetryProgressMark(job)
  const madeProgress = progressMark !== String(job.llmRequestRetryProgressMark || '')
  return {
    progressMark,
    retryCount: madeProgress ? 0 : Math.max(0, Number(job.llmRequestRetries || 0)),
  }
}

export const getLlmRateLimitRetryState = (job = {}) => {
  const progressMark = getLlmRetryProgressMark(job)
  const madeProgress = progressMark !== String(job.llmRateLimitRetryProgressMark || '')
  return {
    progressMark,
    retryCount: madeProgress ? 0 : Math.max(0, Number(job.llmRateLimitRetries || 0)),
  }
}

export const getLlmValidationRetryState = (job = {}) => {
  const progressMark = getLlmRetryProgressMark(job, { includeStage: true })
  const madeProgress = progressMark !== String(job.llmValidationRetryProgressMark || '')
  return {
    progressMark,
    retryCount: madeProgress ? 0 : Math.max(0, Number(job.llmValidationRetries || 0)),
  }
}

export const getLlmEntryLimitForRuntime = (job = {}, configuredLimit = LLM_ENTRIES_PER_STEP) => {
  const batchSize = Math.max(1, Number.parseInt(job.llmBatchSize, 10) || 1)
  const concurrency = Math.max(1, Number.parseInt(job.llmConcurrency, 10) || 1)
  const hardLimit = Math.max(1, Number.parseInt(configuredLimit, 10) || LLM_ENTRIES_PER_STEP)
  // Limit each Workflow step by request rounds, not only entry count.  A job
  // degraded to batch=1/concurrency=1 would otherwise attempt 100 sequential
  // requests and get killed by the Function timeout before it can yield.
  return Math.min(hardLimit, batchSize * concurrency * LLM_BATCH_ROUNDS_PER_STEP)
}

export const hasWorksheetStepTimeBudget = (startedAt, currentTime = now(), limitMs = WORKFLOW_STEP_SOFT_LIMIT_MS) => (
  Math.max(0, Number(currentTime) - Number(startedAt || 0)) < Math.max(1, Number(limitMs) || WORKFLOW_STEP_SOFT_LIMIT_MS)
)

export const shouldYieldWorksheetStep = (
  renderingStarted,
  startedAt,
  currentTime = now(),
  limitMs = WORKFLOW_STEP_SOFT_LIMIT_MS,
) => !renderingStarted && !hasWorksheetStepTimeBudget(startedAt, currentTime, limitMs)

export const getLlmRequestRetryDelayMs = (retryCount = 0) => {
  const normalizedRetryCount = Math.max(0, Number(retryCount) || 0)
  if (normalizedRetryCount < MAX_REQUEST_REQUEUES) {
    return Math.min(MAX_INTERNAL_QUEUE_WAIT_MS, 3000 * (normalizedRetryCount + 1))
  }
  const recoveryRound = normalizedRetryCount - MAX_REQUEST_REQUEUES
  return Math.min(
    MAX_REQUEST_RECOVERY_WAIT_MS,
    MIN_REQUEST_RECOVERY_WAIT_MS * (2 ** Math.min(2, recoveryRound)),
  )
}

export const getLlmValidationRetryDelayMs = (retryCount = 0) => {
  const normalizedRetryCount = Math.max(0, Number(retryCount) || 0)
  if (normalizedRetryCount < MAX_VALIDATION_REQUEUES) {
    return Math.min(MAX_INTERNAL_QUEUE_WAIT_MS, VALIDATION_RETRY_DELAY_MS * (normalizedRetryCount + 1))
  }
  const recoveryRound = normalizedRetryCount - MAX_VALIDATION_REQUEUES
  return Math.min(MAX_INTERNAL_QUEUE_WAIT_MS, 15_000 * (2 ** Math.min(2, recoveryRound)))
}

export const hasWorksheetExecutionLease = (job = {}, leaseId = '') => (
  Boolean(leaseId) && String(job?.executionLeaseId || '') === String(leaseId)
)

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
  if (current.fallbackModels.length) {
    const [nextModel, ...remainingFallbacks] = current.fallbackModels
    const nextRuntime = getLlmJobRuntime(nextModel)
    return {
      llmModel: nextRuntime.model,
      llmBatchSize: Math.max(1, Math.min(current.batchSize, nextRuntime.batchSize)),
      llmConcurrency: Math.max(1, Math.min(nextRuntime.concurrency, current.concurrency - 1 || 1)),
      llmFallbackModels: [...remainingFallbacks, current.model],
      reason: `切换备用模型 ${nextRuntime.model}，并发降到 ${Math.max(1, Math.min(nextRuntime.concurrency, current.concurrency - 1 || 1))}`,
    }
  }
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
  return {
    llmModel: current.model,
    llmBatchSize: current.batchSize,
    llmConcurrency: current.concurrency,
    llmFallbackModels: current.fallbackModels,
    reason: '等待限流恢复',
  }
}

export const tuneLlmRuntimeAfterRequestFailure = (job = {}, error = {}, { madeProgress = false } = {}) => {
  const current = buildLlmRuntimeForJob(job)
  // A 400 rejects the request payload itself. Lowering concurrency only makes
  // the same invalid request arrive more slowly, so isolate it with a smaller
  // batch before rotating models.
  if (Number(error?.status) === 400 && current.batchSize > 1) {
    const nextBatchSize = Math.max(1, Math.floor(current.batchSize / 2))
    return {
      llmModel: current.model,
      llmBatchSize: nextBatchSize,
      llmConcurrency: current.concurrency,
      llmFallbackModels: current.fallbackModels,
      reason: `HTTP 400，批次从 ${current.batchSize} 降到 ${nextBatchSize} 以定位被拒绝的条目`,
    }
  }
  if ([400, 401, 403].includes(Number(error?.status)) && current.fallbackModels.length) {
    const [nextModel, ...remainingFallbacks] = current.fallbackModels
    const nextRuntime = getLlmJobRuntime(nextModel)
    return {
      llmModel: nextRuntime.model,
      llmBatchSize: Math.max(1, Math.min(current.batchSize, nextRuntime.batchSize)),
      llmConcurrency: Math.max(1, Math.min(current.concurrency, nextRuntime.concurrency)),
      llmFallbackModels: [...remainingFallbacks, current.model],
      reason: `HTTP ${error.status} 访问被拒绝，切换备用模型 ${nextRuntime.model}`,
    }
  }
  if (madeProgress) {
    return {
      llmModel: current.model,
      llmBatchSize: current.batchSize,
      llmConcurrency: current.concurrency,
      llmFallbackModels: current.fallbackModels,
      reason: '本轮已有有效进度，保持当前参数补跑超时条目',
    }
  }
  if (current.concurrency > 1) {
    return {
      llmModel: current.model,
      llmBatchSize: current.batchSize,
      llmConcurrency: current.concurrency - 1,
      llmFallbackModels: current.fallbackModels,
      reason: `降低并发到 ${current.concurrency - 1}`,
    }
  }
  if (current.fallbackModels.length) {
    const [nextModel, ...remainingFallbacks] = current.fallbackModels
    const nextRuntime = getLlmJobRuntime(nextModel)
    return {
      llmModel: nextRuntime.model,
      llmBatchSize: Math.max(1, Math.min(current.batchSize, nextRuntime.batchSize)),
      llmConcurrency: 1,
      llmFallbackModels: [...remainingFallbacks, current.model],
      reason: `切换备用模型 ${nextRuntime.model}，并发保持 1`,
    }
  }
  if (current.batchSize > 1) {
    const nextBatchSize = Math.max(1, Math.floor(current.batchSize / 2))
    return {
      llmModel: current.model,
      llmBatchSize: nextBatchSize,
      llmConcurrency: 1,
      llmFallbackModels: current.fallbackModels,
      reason: `降低批次到 ${nextBatchSize}`,
    }
  }
  return {
    llmModel: current.model,
    llmBatchSize: current.batchSize,
    llmConcurrency: 1,
    llmFallbackModels: current.fallbackModels,
    reason: '保持最低并发等待上游恢复',
  }
}

const tuneLlmRuntimeAfterValidationFailure = (job = {}) => {
  const current = buildLlmRuntimeForJob(job)
  if (current.batchSize > 1) {
    const nextBatchSize = Math.max(1, Math.floor(current.batchSize / 2))
    return {
      llmModel: current.model,
      llmBatchSize: nextBatchSize,
      llmConcurrency: current.concurrency,
      llmFallbackModels: current.fallbackModels,
      reason: `降低批次到 ${nextBatchSize}`,
    }
  }
  if (current.concurrency > 1) {
    return {
      llmModel: current.model,
      llmBatchSize: current.batchSize,
      llmConcurrency: current.concurrency - 1,
      llmFallbackModels: current.fallbackModels,
      reason: `降低并发到 ${current.concurrency - 1}`,
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
    reason: '复用当前模型补跑未完成条目',
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
      ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode), job.wordCount || 0)),
      currentStep: '已取消',
      message: '任务已取消。',
    },
  })
}))

const listJobStates = async ({ includeAll = false } = {}) => {
  const objects = await listObjects({ prefix: `${JOB_PREFIX}/` })
  const jobKeys = objects
    .map((item) => item.Key)
    .filter((key) => key?.endsWith('/job.json'))
  const jobs = await Promise.all(jobKeys.map((key) => getObjectJson({ key }).catch(() => null)))
  const normalizedJobs = await settleStaleCanceledJobs(jobs.filter(Boolean))
  const sortedJobs = normalizedJobs
    .filter(Boolean)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
  return includeAll ? sortedJobs : sortedJobs.slice(0, MAX_LIST_JOBS)
}

const processSingleJob = async (job) => {
  if (!job || TERMINAL_STATUSES.has(job.status) || job.status === 'canceling') return
  const snapshot = await readJobWithMetadata(job.id).catch(() => null)
  const latestJob = snapshot?.value
  if (!latestJob || TERMINAL_STATUSES.has(latestJob.status) || latestJob.status === 'canceling') return
  const payload = await readJobPayload(job.id).catch(() => null)
  if (!payload) return
  let ownershipEtag = snapshot.etag
  let liveJob
  const executionLeaseId = crypto.randomUUID()
  try {
    const claimed = await writeOwnedJob({
      ...latestJob,
      status: 'processing',
      startedAt: latestJob.startedAt || now(),
      nextAttemptAt: 0,
      error: '',
      executionLeaseId,
      progress: {
        ...(latestJob.progress || resetJobProgress(latestJob)),
        currentStep: latestJob.progress?.currentStep || '准备处理',
        message: latestJob.status === 'processing'
          ? '服务器正在从已保存的进度恢复任务…'
          : '服务器正在处理任务…',
      },
    }, ownershipEtag)
    liveJob = claimed.job
    ownershipEtag = claimed.etag
  } catch (error) {
    if (error?.code === 'JOB_OWNERSHIP_LOST') return
    throw error
  }
  let lastPersistedProgress = liveJob.progress || null
  const stepStartedAt = now()
  let lastProgressWriteAt = now()
  let cancelKnown = false
  let lastCancelCheckAt = 0
  let renderingStarted = false

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

  const shouldCancelOrYield = async () => {
    if (shouldYieldWorksheetStep(renderingStarted, stepStartedAt)) {
      const error = new Error('本轮服务器运行时间已到，进度已保存。')
      error.code = 'JOB_STEP_YIELDED'
      throw error
    }
    return shouldCancel()
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
    const writeIntervalMs = renderingStarted ? RENDER_PROGRESS_WRITE_INTERVAL_MS : PROGRESS_WRITE_INTERVAL_MS
    const writeWordDelta = renderingStarted ? RENDER_PROGRESS_WRITE_WORD_DELTA : PROGRESS_WRITE_WORD_DELTA
    const intervalElapsed = now() - lastProgressWriteAt >= writeIntervalMs
    const shouldFlush =
      force ||
      !lastPersistedProgress ||
      stageChanged ||
      stageWordDelta >= writeWordDelta ||
      completedStepDelta >= 1 ||
      intervalElapsed ||
      Number(nextProgress?.percent || 0) >= 100

    if (!shouldFlush) return
    const written = await writeOwnedJob(liveJob, ownershipEtag)
    liveJob = written.job
    ownershipEtag = written.etag
    lastPersistedProgress = liveJob.progress || nextProgress
    lastProgressWriteAt = now()
  }

  let progressChain = Promise.resolve()
  let cacheChain = Promise.resolve()
  const handleProgress = (event) => {
    progressChain = progressChain.then(() => persistProgress(progressFromEvent(liveJob, event)))
    return progressChain
  }
  const checkpointCache = (cache) => {
    cacheChain = cacheChain.then(async () => {
      const currentJob = await readLatestJobState(job.id)
      if (!hasWorksheetExecutionLease(currentJob, executionLeaseId)) {
        const error = new Error('任务缓存已由新的服务器执行器接管。')
        error.code = 'JOB_OWNERSHIP_LOST'
        throw error
      }
      return writeJsonObject({ key: jobCacheKey(job.id), value: cache })
    })
    return cacheChain
  }

  try {
    await ensureNotCanceled(true)
    const initialCache = await getObjectJson({ key: jobCacheKey(job.id) }).catch(() => null)
    const llmBatchSize = payload.llmBatchSize || latestJob.llmBatchSize
    const llmConcurrency = payload.llmConcurrency || latestJob.llmConcurrency
    const result = await generateWorksheetArchive({
      rows: payload.rows || [],
      fileName: payload.fileName || '词组练习.xlsx',
      questionTypes: payload.questionTypes || latestJob.questionTypes,
      generationMode: payload.generationMode || latestJob.generationMode || GENERATION_MODE_FIXED_TEST_PAPER,
      llmModel: payload.llmModel || latestJob.llmModel || getDefaultLlmModel(),
      llmBatchSize,
      llmConcurrency,
      llmFallbackModels: payload.llmFallbackModels || latestJob.llmFallbackModels,
      llmEntryLimit: getLlmEntryLimitForRuntime({ llmBatchSize, llmConcurrency }),
      variationSeed: payload.variationSeed || latestJob.variationSeed || '',
      exportSuffix: payload.exportSuffix || latestJob.exportSuffix || '',
      legacyQuestionCount: payload.legacyQuestionCount || latestJob.legacyQuestionCount,
      testPaperGroupSizes: payload.testPaperGroupSizes || latestJob.testPaperGroupSizes,
      withChineseTranslation: normalizeWithChineseTranslation(payload.withChineseTranslation ?? latestJob.withChineseTranslation),
      onProgress: handleProgress,
      onShouldCancel: shouldCancelOrYield,
      onRenderStart: () => {
        renderingStarted = true
      },
      initialCache,
      onCacheCheckpoint: checkpointCache,
    })

    await ensureNotCanceled(true)
    const artifactKey = jobArtifactKey(job.id)
    await putObject({
      key: artifactKey,
      body: result.buffer,
      contentType: 'application/zip',
    })

    const completed = await writeOwnedJob({
      ...liveJob,
      status: 'completed',
      completedAt: now(),
      artifactKey,
      exportFileName: result.fileName,
      wordCount: result.wordCount,
      downloadSize: result.buffer.length,
      nextAttemptAt: 0,
      progress: {
        ...(liveJob.progress || createProgress(buildTotalSteps(latestJob.questionTypes || [], latestJob.wordCount || 0, latestJob.generationMode, latestJob.testPaperGroupSizes), latestJob.wordCount || 0)),
        completedSteps: buildTotalSteps(latestJob.questionTypes || [], latestJob.wordCount || 0, latestJob.generationMode, latestJob.testPaperGroupSizes),
        currentStep: '打包完成',
        message: '已完成',
        percent: 100,
        stageLabel: '打包完成',
        stageWordTotal: latestJob.wordCount || result.wordCount || 0,
        stageWordCompleted: latestJob.wordCount || result.wordCount || 0,
      },
    }, ownershipEtag)
    liveJob = completed.job
    ownershipEtag = completed.etag
    // Job finished — keep the LLM cache so this job can be re-exported with
    // new rendering rules without re-running LLM calls.
  } catch (error) {
    if (error?.code === 'JOB_OWNERSHIP_LOST') return
    if (error?.code === 'JOB_STEP_YIELDED') {
      await Promise.all([progressChain, cacheChain])
      try {
        const queued = await writeOwnedJob({
          ...liveJob,
          status: 'queued',
          llmRequestRetries: 0,
          llmRequestRetryProgressMark: '',
          llmRateLimitRetries: 0,
          llmRateLimitRetryProgressMark: '',
          llmValidationRetries: 0,
          llmValidationRetryProgressMark: '',
          nextAttemptAt: now() + 1000,
          error: '',
          progress: {
            ...(liveJob.progress || resetJobProgress(liveJob)),
            message: '本轮进度已保存，服务器正在继续处理…',
          },
        }, ownershipEtag)
        liveJob = queued.job
        ownershipEtag = queued.etag
      } catch (writeError) {
        if (writeError?.code !== 'JOB_OWNERSHIP_LOST') throw writeError
      }
      return
    }
    if (error?.code === 'LLM_BATCH_REJECTED') {
      await Promise.all([progressChain, cacheChain])
      const currentBatchSize = Math.max(1, Number(liveJob.llmBatchSize || payload?.llmBatchSize || 1))
      const nextBatchSize = Math.max(1, Math.floor(currentBatchSize / 2))
      if (nextBatchSize < currentBatchSize) {
        const nextAttemptAt = now() + 1000
        const validationReason = String(error.message || '').replace(/\s+/g, ' ').slice(0, 240)
        const waitingMessage = `LLM 整批结果未通过校验，批次已从 ${currentBatchSize} 降到 ${nextBatchSize}，正在继续处理。${validationReason ? ` 原因：${validationReason}` : ''}`
        try {
          const queued = await writeOwnedJob({
            ...liveJob,
            status: 'queued',
            llmBatchSize: nextBatchSize,
            nextAttemptAt,
            error: '',
            progress: {
              ...(liveJob.progress || resetJobProgress(liveJob)),
              currentStep: '调整 LLM 批次',
              message: waitingMessage,
            },
          }, ownershipEtag)
          liveJob = queued.job
          ownershipEtag = queued.etag
          await writeJsonObject({
            key: jobPayloadKey(job.id),
            value: {
              ...(payload || {}),
              llmBatchSize: nextBatchSize,
            },
          })
        } catch (writeError) {
          if (writeError?.code !== 'JOB_OWNERSHIP_LOST') throw writeError
        }
        return
      }
    }
    if (error?.code === 'JOB_CANCELED') {
      const latestJob = await readLatestJobState(job.id)
      await writeJob({
        ...(latestJob || liveJob),
        status: 'canceled',
        canceledAt: now(),
        nextAttemptAt: 0,
        error: '',
        progress: {
          ...((latestJob && latestJob.progress) || liveJob.progress || createProgress(buildTotalSteps((latestJob && latestJob.questionTypes) || job.questionTypes || [], (latestJob && latestJob.wordCount) || job.wordCount || 0, (latestJob && latestJob.generationMode) || job.generationMode), (latestJob && latestJob.wordCount) || job.wordCount || 0)),
          currentStep: '已取消',
          message: '任务已取消。',
        },
      })
      await deleteObject({ key: jobCacheKey(job.id) }).catch(() => {})
      return
    }
    if (error?.code === 'LLM_REQUEST_FAILED' && error?.retryable) {
      await Promise.all([progressChain, cacheChain])
      const latestJobForRetry = await readLatestJobState(job.id)
      const retryBaseJob = {
        ...(latestJobForRetry || liveJob),
        questionTypes: (latestJobForRetry && latestJobForRetry.questionTypes) || liveJob.questionTypes || job.questionTypes || [],
        wordCount: (latestJobForRetry && latestJobForRetry.wordCount) || liveJob.wordCount || job.wordCount || 0,
      }
      const { progressMark, retryCount } = getLlmRequestRetryState(retryBaseJob)
      const madeProgressThisAttempt = getLlmRetryProgressMark(retryBaseJob) !== getLlmRetryProgressMark(job)
      const runtimeUpdate = tuneLlmRuntimeAfterRequestFailure(retryBaseJob, error, {
        madeProgress: madeProgressThisAttempt,
      })
      const delayMs = getLlmRequestRetryDelayMs(retryCount)
      const nextAttemptAt = now() + delayMs
      const prolongedWait = retryCount >= MAX_REQUEST_REQUEUES
      const errorDetail = String(error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      const waitingMessage = prolongedWait
        ? `LLM 网关仍不可用，任务和进度已保留，将在 ${Math.max(1, Math.ceil(delayMs / 60000))} 分钟后继续重试（连续失败 ${retryCount + 1} 轮）。`
        : `LLM 请求暂时失败，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后从已保存进度继续；${runtimeUpdate.reason}。${errorDetail ? ` 原因：${errorDetail}` : ''}`
      const queuedRetryJob = await writeJob({
        ...retryBaseJob,
        status: 'queued',
        error: '',
        lastLlmError: errorDetail,
        llmModel: runtimeUpdate.llmModel,
        llmBatchSize: runtimeUpdate.llmBatchSize,
        llmConcurrency: runtimeUpdate.llmConcurrency,
        llmFallbackModels: runtimeUpdate.llmFallbackModels,
        llmRequestRetries: retryCount + 1,
        llmRequestRetryProgressMark: progressMark,
        nextAttemptAt,
        progress: {
          ...(retryBaseJob.progress || resetJobProgress(retryBaseJob)),
          currentStep: '等待 LLM 网关恢复',
          message: waitingMessage,
        },
      })
      await writeJsonObject({
        key: jobPayloadKey(job.id),
        value: {
          ...(payload || {}),
          llmModel: queuedRetryJob.llmModel,
          llmBatchSize: queuedRetryJob.llmBatchSize,
          llmConcurrency: queuedRetryJob.llmConcurrency,
          llmFallbackModels: queuedRetryJob.llmFallbackModels || [],
        },
      })
      return
    }
    if (error?.code === 'LLM_GENERATION_INCOMPLETE') {
      const latestJobForRetry = await readLatestJobState(job.id)
      if (latestJobForRetry && ['canceling', 'canceled'].includes(latestJobForRetry.status)) {
        await writeJob({
          ...latestJobForRetry,
          status: 'canceled',
          canceledAt: latestJobForRetry.canceledAt || now(),
          nextAttemptAt: 0,
          error: '',
          progress: {
            ...(latestJobForRetry.progress || createProgress(buildTotalSteps(latestJobForRetry.questionTypes || [], latestJobForRetry.wordCount || 0, latestJobForRetry.generationMode), latestJobForRetry.wordCount || 0)),
            currentStep: '已取消',
            message: '任务已取消。',
          },
        })
        await deleteObject({ key: jobCacheKey(job.id) }).catch(() => {})
        return
      }

      const retryBaseJob = {
        ...(latestJobForRetry || liveJob),
        questionTypes: (latestJobForRetry && latestJobForRetry.questionTypes) || liveJob.questionTypes || job.questionTypes || [],
        wordCount: (latestJobForRetry && latestJobForRetry.wordCount) || liveJob.wordCount || job.wordCount || 0,
      }
      const { progressMark, retryCount } = getLlmValidationRetryState(retryBaseJob)
      const runtimeUpdate = tuneLlmRuntimeAfterValidationFailure(retryBaseJob)
      const delayMs = getLlmValidationRetryDelayMs(retryCount)
      const nextAttemptAt = now() + delayMs
      const waitingMessage = retryCount >= MAX_VALIDATION_REQUEUES
        ? `LLM 仍有条目未通过校验，缓存和进度已保留，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后继续补跑（连续 ${retryCount + 1} 轮）；${runtimeUpdate.reason}。`
        : `LLM 返回内容未通过校验，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后自动补跑未完成条目；${runtimeUpdate.reason}。`
      const queuedRetryJob = await writeJob({
        ...retryBaseJob,
        status: 'queued',
        error: '',
        llmModel: runtimeUpdate.llmModel,
        llmBatchSize: runtimeUpdate.llmBatchSize,
        llmConcurrency: runtimeUpdate.llmConcurrency,
        llmFallbackModels: runtimeUpdate.llmFallbackModels,
        llmValidationRetries: retryCount + 1,
        llmValidationRetryProgressMark: progressMark,
        nextAttemptAt,
        progress: {
          ...(retryBaseJob.progress || resetJobProgress(retryBaseJob)),
          currentStep: '等待题面补跑',
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
          generationMode: payload?.generationMode || queuedRetryJob.generationMode || GENERATION_MODE_FIXED_TEST_PAPER,
          withChineseTranslation: normalizeWithChineseTranslation(payload?.withChineseTranslation ?? queuedRetryJob.withChineseTranslation),
          llmModel: queuedRetryJob.llmModel,
          llmBatchSize: queuedRetryJob.llmBatchSize,
          llmConcurrency: queuedRetryJob.llmConcurrency,
          llmFallbackModels: queuedRetryJob.llmFallbackModels || [],
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
            ...(latestJobForRetry.progress || createProgress(buildTotalSteps(latestJobForRetry.questionTypes || [], latestJobForRetry.wordCount || 0, latestJobForRetry.generationMode), latestJobForRetry.wordCount || 0)),
            currentStep: '已取消',
            message: '任务已取消。',
          },
        })
        await deleteObject({ key: jobCacheKey(job.id) }).catch(() => {})
        return
      }
      const retryBaseJob = {
        ...(latestJobForRetry || liveJob),
        questionTypes: (latestJobForRetry && latestJobForRetry.questionTypes) || liveJob.questionTypes || job.questionTypes || [],
        wordCount: (latestJobForRetry && latestJobForRetry.wordCount) || liveJob.wordCount || job.wordCount || 0,
      }
      const { progressMark, retryCount } = getLlmRateLimitRetryState(retryBaseJob)
      const runtimeUpdate = tuneLlmRuntimeAfterRateLimit(retryBaseJob)
      const delayMs = computeRateLimitDelayMs(error, retryCount)
      const nextAttemptAt = now() + delayMs
      const waitingMessage = retryCount >= MAX_RATE_LIMIT_REQUEUES
        ? `LLM 持续限流，任务和进度已保留，将在 ${Math.max(1, Math.ceil(delayMs / 1000))} 秒后继续重试（连续限流 ${retryCount + 1} 轮）。`
        : `LLM 触发限流，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后自动重试；${runtimeUpdate.reason}。`
      const queuedRetryJob = await writeJob({
        ...retryBaseJob,
        status: 'queued',
        error: '',
        llmModel: runtimeUpdate.llmModel,
        llmBatchSize: runtimeUpdate.llmBatchSize,
        llmConcurrency: runtimeUpdate.llmConcurrency,
        llmFallbackModels: runtimeUpdate.llmFallbackModels,
        llmRateLimitRetries: retryCount + 1,
        llmRateLimitRetryProgressMark: progressMark,
        nextAttemptAt,
        progress: {
          ...(retryBaseJob.progress || resetJobProgress(retryBaseJob)),
          currentStep: '等待限流恢复',
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
          generationMode: payload?.generationMode || queuedRetryJob.generationMode || GENERATION_MODE_FIXED_TEST_PAPER,
          withChineseTranslation: normalizeWithChineseTranslation(payload?.withChineseTranslation ?? queuedRetryJob.withChineseTranslation),
          llmModel: queuedRetryJob.llmModel,
          llmBatchSize: queuedRetryJob.llmBatchSize,
          llmConcurrency: queuedRetryJob.llmConcurrency,
          llmFallbackModels: queuedRetryJob.llmFallbackModels || [],
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
        ...(liveJob.progress || createProgress(buildTotalSteps(latestJob.questionTypes || [], latestJob.wordCount || 0, latestJob.generationMode), latestJob.wordCount || 0)),
        message: error.message || '生成失败。',
      },
    })
  }
}

export const processWorksheetJobAttempt = async (jobId) => {
  let job = await readJob(jobId)
  if (!job) {
    const error = new Error('未找到对应任务。')
    error.statusCode = 404
    throw error
  }

  const currentTime = now()
  if (job.status === 'canceling' && currentTime - Number(job.updatedAt || 0) > STALE_PROCESSING_MS) {
    job = await writeJob({
      ...job,
      status: 'canceled',
      canceledAt: job.canceledAt || currentTime,
      nextAttemptAt: 0,
      error: '',
      progress: {
        ...(job.progress || resetJobProgress(job)),
        currentStep: '已取消',
        message: '任务已取消。',
      },
    })
  }

  if (TERMINAL_STATUSES.has(job.status)) return { ...summarizeJob(job), resumeAt: 0 }

  const resumeAt = job.status === 'processing' || job.status === 'canceling'
    ? Number(job.updatedAt || currentTime) + STALE_PROCESSING_MS
    : Number(job.nextAttemptAt || 0)
  if (resumeAt > currentTime) return { ...summarizeJob(job), resumeAt }

  await processSingleJob(job)
  job = await readJob(jobId)
  const nextResumeAt = job.status === 'processing' || job.status === 'canceling'
    ? Number(job.updatedAt || now()) + STALE_PROCESSING_MS
    : Number(job.nextAttemptAt || 0)
  return { ...summarizeJob(job), resumeAt: nextResumeAt }
}

export const failWorksheetJobStart = async (jobId, message) => {
  const job = await readJob(jobId).catch(() => null)
  if (!job || job.status !== 'queued') return job ? summarizeJob(job) : null
  return summarizeJob(await writeJob({
    ...job,
    status: 'failed',
    failedAt: now(),
    nextAttemptAt: 0,
    error: message || 'Workflow 启动失败。',
    progress: {
      ...(job.progress || resetJobProgress(job)),
      currentStep: 'Workflow 启动失败',
      message: message || 'Workflow 启动失败。',
    },
  }))
}

export const submitWorksheetJob = async ({
  rows,
  fileName,
  questionTypes,
  generationMode,
  llmModel,
  legacyQuestionCount,
  testPaperGroupSizes,
  withChineseTranslation,
  batchId = '',
  copyIndex = 0,
  copyCount = 1,
  variationSeed = '',
  exportSuffix = '',
  allowDuplicate = false,
}) => {
  const normalizedMode = normalizeGenerationMode(generationMode)
  const normalizedLegacyQuestionCount = normalizeLegacyQuestionCount(legacyQuestionCount)
  const normalizedTestPaperGroupSizes = normalizeTestPaperGroupSizes(testPaperGroupSizes)
  const normalizedWithChineseTranslation = normalizeWithChineseTranslation(withChineseTranslation)
  const llmRuntime = getLlmJobRuntime(String(llmModel || getDefaultLlmModel()).trim())
  const normalizedFileName = String(fileName || '词组练习.xlsx')
  const fingerprint = buildJobFingerprint({
    rows,
    fileName: normalizedFileName,
    questionTypes,
    generationMode: normalizedMode,
    llmModel: llmRuntime.model,
    legacyQuestionCount: normalizedLegacyQuestionCount,
    testPaperGroupSizes: normalizedTestPaperGroupSizes,
    withChineseTranslation: normalizedWithChineseTranslation,
  })
  if (!allowDuplicate) {
    const activeJobs = (await listJobStates()).filter((candidate) => (
      ['queued', 'processing'].includes(candidate?.status)
    ))
    let duplicate = activeJobs.find((candidate) => candidate.fingerprint === fingerprint)
    if (!duplicate) {
      const legacyCandidates = activeJobs.filter((candidate) => !candidate.fingerprint)
      const legacyFingerprints = await Promise.all(legacyCandidates.map(async (candidate) => {
        const payload = await readJobPayload(candidate.id).catch(() => null)
        if (!payload) return null
        return {
          candidate,
          fingerprint: buildJobFingerprint({
            rows: payload.rows || [],
            fileName: payload.fileName || candidate.fileName,
            questionTypes: payload.questionTypes || candidate.questionTypes || [],
            generationMode: normalizeGenerationMode(payload.generationMode || candidate.generationMode),
            llmModel: payload.llmModel || candidate.llmModel || getDefaultLlmModel(),
            legacyQuestionCount: normalizeLegacyQuestionCount(payload.legacyQuestionCount ?? candidate.legacyQuestionCount),
            testPaperGroupSizes: normalizeTestPaperGroupSizes(payload.testPaperGroupSizes || candidate.testPaperGroupSizes),
            withChineseTranslation: normalizeWithChineseTranslation(payload.withChineseTranslation ?? candidate.withChineseTranslation),
          }),
        }
      }))
      duplicate = legacyFingerprints.find((item) => item?.fingerprint === fingerprint)?.candidate
    }
    if (duplicate) return { job: summarizeJob(duplicate), created: false }
  }

  const id = crypto.randomUUID()
  const submittedAt = now()
  const totalSteps = buildTotalSteps(questionTypes, Array.isArray(rows) ? rows.length : 0, normalizedMode, normalizedTestPaperGroupSizes)
  const job = {
    id,
    fingerprint,
    batchId,
    copyIndex,
    copyCount,
    variationSeed,
    exportSuffix,
    fileName: normalizedFileName,
    questionTypes,
    generationMode: normalizedMode,
    legacyQuestionCount: normalizedLegacyQuestionCount,
    testPaperGroupSizes: normalizedTestPaperGroupSizes,
    withChineseTranslation: normalizedWithChineseTranslation,
    llmModel: llmRuntime.model,
    llmFallbackModels: llmRuntime.fallbackModels,
    llmBatchSize: llmRuntime.batchSize,
    llmConcurrency: llmRuntime.concurrency,
    llmRateLimitRetries: 0,
    llmRateLimitRetryProgressMark: '',
    llmValidationRetries: 0,
    llmValidationRetryProgressMark: '',
    llmRequestRetries: 0,
    llmRequestRetryProgressMark: '',
    nextAttemptAt: 0,
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
        generationMode: job.generationMode,
        legacyQuestionCount: job.legacyQuestionCount,
        testPaperGroupSizes: job.testPaperGroupSizes,
        withChineseTranslation: job.withChineseTranslation,
        llmModel: job.llmModel,
        llmFallbackModels: job.llmFallbackModels,
        llmBatchSize: job.llmBatchSize,
        llmConcurrency: job.llmConcurrency,
        variationSeed: job.variationSeed,
        exportSuffix: job.exportSuffix,
      },
    }),
    writeJsonObject({
      key: jobStateKey(id),
      value: job,
    }),
  ])

  return { job: summarizeJob(job), created: true }
}

export const retryWorksheetJob = async (jobId, { questionTypes } = {}) => {
  const sourceJob = await readJob(jobId)
  if (sourceJob.status !== 'failed') {
    const error = new Error('只有失败任务可以重新生成。')
    error.statusCode = 409
    throw error
  }
  const payload = await readJobPayload(jobId).catch(() => null)
  if (!payload || !Array.isArray(payload.rows)) {
    const error = new Error('找不到失败任务的原始词表数据。')
    error.statusCode = 404
    throw error
  }
  const submission = await submitWorksheetJob({
    rows: payload.rows,
    fileName: payload.fileName || sourceJob.fileName,
    questionTypes: questionTypes || payload.questionTypes || sourceJob.questionTypes,
    generationMode: payload.generationMode || sourceJob.generationMode,
    llmModel: payload.llmModel || sourceJob.llmModel,
    legacyQuestionCount: payload.legacyQuestionCount ?? sourceJob.legacyQuestionCount,
    testPaperGroupSizes: payload.testPaperGroupSizes || sourceJob.testPaperGroupSizes,
    withChineseTranslation: payload.withChineseTranslation ?? sourceJob.withChineseTranslation,
    batchId: sourceJob.batchId || '',
    copyIndex: sourceJob.copyIndex || 0,
    copyCount: sourceJob.copyCount || 1,
    variationSeed: payload.variationSeed || sourceJob.variationSeed || '',
    exportSuffix: payload.exportSuffix || sourceJob.exportSuffix || '',
  })
  if (submission.created) {
    const sourceCache = await getObjectJson({ key: jobCacheKey(jobId) }).catch(() => null)
    if (sourceCache) await writeJsonObject({ key: jobCacheKey(submission.job.id), value: sourceCache })
  }
  return submission
}

export const listWorksheetJobs = async () => {
  const jobs = await listJobStates()
  return jobs.map(summarizeJob)
}

export const getMissingBatchCopyIndexes = (jobs = [], expectedCount = 0) => {
  const existingIndexes = new Set((jobs || []).map((job) => Number(job.copyIndex || 0)))
  return Array.from({ length: Math.max(0, Number(expectedCount) || 0) }, (_, index) => index + 1)
    .filter((copyIndex) => !existingIndexes.has(copyIndex))
}

export const getWorksheetRecoveryRuntime = (savedCache, { forceReset = false } = {}) => (
  savedCache && !forceReset ? null : getLlmJobRuntime(getDefaultLlmModel())
)

export const mergeWorksheetCacheValues = (source = {}, target = {}) => ({
  lexical: { ...(source?.lexical || {}), ...(target?.lexical || {}) },
  basic: { ...(source?.basic || {}), ...(target?.basic || {}) },
  synonym: { ...(source?.synonym || {}), ...(target?.synonym || {}) },
})

export const seedWorksheetJobCaches = async (sourceJobIds, targetJobId) => {
  const sourceIds = (Array.isArray(sourceJobIds) ? sourceJobIds : [sourceJobIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  const targetId = String(targetJobId || '').trim()
  if (!sourceIds.length || !targetId || sourceIds.includes(targetId)) {
    const error = new Error('缓存恢复任务 id 无效。')
    error.statusCode = 400
    throw error
  }
  const sourceCaches = []
  const missingSourceJobIds = []
  for (const sourceId of [...new Set(sourceIds)]) {
    const sourceCache = await getObjectJson({ key: jobCacheKey(sourceId) }).catch(() => null)
    if (!sourceCache) {
      missingSourceJobIds.push(sourceId)
      continue
    }
    sourceCaches.push(sourceCache)
  }
  if (!sourceCaches.length) {
    const error = new Error('提供的源任务缓存均不存在。')
    error.statusCode = 404
    throw error
  }
  const targetCache = await getObjectJson({ key: jobCacheKey(targetId) }).catch(() => null)
  const mergedCache = sourceCaches.reduce(
    (merged, sourceCache) => mergeWorksheetCacheValues(sourceCache, merged),
    targetCache || {},
  )
  await writeJsonObject({ key: jobCacheKey(targetId), value: mergedCache })
  return {
    lexical: Object.keys(mergedCache.lexical).length,
    basic: Object.keys(mergedCache.basic).length,
    synonym: Object.keys(mergedCache.synonym).length,
    sourceCount: sourceCaches.length,
    missingSourceJobIds,
  }
}

export const seedWorksheetJobCache = async (sourceJobId, targetJobId) => (
  seedWorksheetJobCaches([sourceJobId], targetJobId)
)

export const shouldRewriteWorksheetJobForMigration = (status, { resetRuntime = false, forceRewrite = false } = {}) => (
  forceRewrite || ['processing', 'failed'].includes(status) || (resetRuntime && status === 'queued')
)

export const prepareWorksheetJobWorkflowMigration = async (jobId, { resetRuntime = false } = {}) => {
  const normalizedJobId = String(jobId || '').trim()
  if (!normalizedJobId) {
    const error = new Error('缺少任务 id。')
    error.statusCode = 400
    throw error
  }

  const savedCache = await getObjectJson({ key: jobCacheKey(normalizedJobId) }).catch(() => null)
  const job = await readJob(normalizedJobId).catch(() => null)
  if (!job) {
    const error = new Error('未找到对应任务。')
    error.statusCode = 404
    throw error
  }
  if (['completed', 'canceled', 'canceling'].includes(job.status)) {
    const error = new Error(`任务处于 ${job.status} 状态，无法迁移 Workflow。`)
    error.statusCode = 409
    throw error
  }

  const recoveryRuntime = getWorksheetRecoveryRuntime(savedCache, { forceReset: resetRuntime })
  const recoveryProgress = savedCache ? (job.progress || resetJobProgress(job)) : resetJobProgress(job)
  // This endpoint is an explicit operator takeover.  An in-flight legacy
  // executor must be invalidated even if it keeps updating the old ETag.
  const migrated = await writeJob({
    ...job,
    status: 'queued',
    startedAt: savedCache ? job.startedAt : 0,
    failedAt: 0,
    executionLeaseId: '',
    llmModel: recoveryRuntime?.model || job.llmModel,
    llmBatchSize: recoveryRuntime?.batchSize || job.llmBatchSize,
    llmConcurrency: recoveryRuntime?.concurrency || job.llmConcurrency,
    llmFallbackModels: recoveryRuntime?.fallbackModels || job.llmFallbackModels,
    llmRequestRetries: 0,
    llmRequestRetryProgressMark: '',
    llmRateLimitRetries: 0,
    llmRateLimitRetryProgressMark: '',
    llmValidationRetries: 0,
    llmValidationRetryProgressMark: '',
    nextAttemptAt: now(),
    error: '',
    progress: {
      ...recoveryProgress,
      currentStep: '迁移到最新 Workflow',
      message: savedCache
        ? '已保留服务器缓存，正在迁移到最新 Workflow 继续处理…'
        : '旧任务缓存不存在，正在由服务器重新生成…',
    },
  })

  if (recoveryRuntime) {
    const payload = await readJobPayload(normalizedJobId).catch(() => null)
    if (payload) {
      await writeJsonObject({
        key: jobPayloadKey(normalizedJobId),
        value: {
          ...payload,
          llmModel: recoveryRuntime.model,
          llmBatchSize: recoveryRuntime.batchSize,
          llmConcurrency: recoveryRuntime.concurrency,
          llmFallbackModels: recoveryRuntime.fallbackModels,
        },
      })
    }
  }

  return summarizeJob(migrated)
}

export const prepareWorksheetBatchWorkflowMigration = async (batchId, { resetRuntime = false, rebuildJobIds = [] } = {}) => {
  const normalizedBatchId = String(batchId || '').trim()
  if (!normalizedBatchId) {
    const error = new Error('缺少批次 id。')
    error.statusCode = 400
    throw error
  }

  const batchJobs = (await listJobStates({ includeAll: true }))
    .filter((job) => job.batchId === normalizedBatchId)
    .sort((left, right) => Number(left.copyIndex || 0) - Number(right.copyIndex || 0))
  if (!batchJobs.length) {
    const error = new Error('未找到对应批次。')
    error.statusCode = 404
    throw error
  }

  const expectedCount = Math.max(...batchJobs.map((job) => Number(job.copyCount || 1)))
  const missingCopyIndexes = getMissingBatchCopyIndexes(batchJobs, expectedCount)
  if (missingCopyIndexes.length) {
    const sourceJob = batchJobs[0]
    const sourcePayload = await readJobPayload(sourceJob.id).catch(() => null)
    if (!sourcePayload || !Array.isArray(sourcePayload.rows)) {
      const error = new Error(`批次任务记录不完整，且无法读取源数据：缺少第 ${missingCopyIndexes.join('、')} 份。`)
      error.statusCode = 409
      throw error
    }
    for (const copyIndex of missingCopyIndexes) {
      const submission = await submitWorksheetJob({
        rows: sourcePayload.rows,
        fileName: sourcePayload.fileName || sourceJob.fileName,
        questionTypes: sourcePayload.questionTypes || sourceJob.questionTypes || [],
        generationMode: sourcePayload.generationMode || sourceJob.generationMode,
        llmModel: sourcePayload.llmModel || sourceJob.llmModel || getDefaultLlmModel(),
        legacyQuestionCount: sourcePayload.legacyQuestionCount ?? sourceJob.legacyQuestionCount,
        testPaperGroupSizes: sourcePayload.testPaperGroupSizes || sourceJob.testPaperGroupSizes,
        withChineseTranslation: sourcePayload.withChineseTranslation ?? sourceJob.withChineseTranslation,
        batchId: normalizedBatchId,
        copyIndex,
        copyCount: expectedCount,
        variationSeed: `${normalizedBatchId}:${copyIndex}`,
        exportSuffix: `第${String(copyIndex).padStart(2, '0')}份`,
        allowDuplicate: true,
      })
      batchJobs.push(submission.job)
    }
    batchJobs.sort((left, right) => Number(left.copyIndex || 0) - Number(right.copyIndex || 0))
  }
  if (batchJobs.length !== expectedCount) {
    const error = new Error(`批次任务记录异常：找到 ${batchJobs.length}/${expectedCount} 份。`)
    error.statusCode = 409
    throw error
  }
  const unsafeJob = batchJobs.find((job) => ['canceled', 'canceling'].includes(job.status))
  if (unsafeJob) {
    const error = new Error(`第 ${unsafeJob.copyIndex || '?'} 份处于 ${unsafeJob.status} 状态，无法迁移 Workflow。`)
    error.statusCode = 409
    throw error
  }

  const migratedJobs = []
  const rebuildIds = new Set((rebuildJobIds || []).map((value) => String(value || '').trim()).filter(Boolean))
  for (const job of batchJobs) {
    const forceRewrite = rebuildIds.has(job.id)
    if (!shouldRewriteWorksheetJobForMigration(job.status, { resetRuntime, forceRewrite })) {
      migratedJobs.push(job)
      continue
    }
    const snapshot = await readJobWithMetadata(job.id)
    const latestJob = snapshot?.value
    if (!latestJob) {
      const error = new Error(`找不到第 ${job.copyIndex || '?'} 份任务状态。`)
      error.statusCode = 404
      throw error
    }
    if (!shouldRewriteWorksheetJobForMigration(latestJob.status, { resetRuntime, forceRewrite })) {
      migratedJobs.push(latestJob)
      continue
    }
    const savedCache = await getObjectJson({ key: jobCacheKey(job.id) }).catch(() => null)
    const recoveryRuntime = getWorksheetRecoveryRuntime(savedCache, { forceReset: resetRuntime })
    const recoveryProgress = savedCache
      ? (latestJob.progress || resetJobProgress(latestJob))
      : resetJobProgress(latestJob)
    const migrated = await writeOwnedJob({
      ...latestJob,
      status: 'queued',
      startedAt: savedCache ? latestJob.startedAt : 0,
      completedAt: forceRewrite ? 0 : latestJob.completedAt,
      failedAt: 0,
      artifactKey: forceRewrite ? '' : latestJob.artifactKey,
      exportFileName: forceRewrite ? '' : latestJob.exportFileName,
      downloadSize: forceRewrite ? 0 : latestJob.downloadSize,
      executionLeaseId: '',
      llmModel: recoveryRuntime?.model || latestJob.llmModel,
      llmBatchSize: recoveryRuntime?.batchSize || latestJob.llmBatchSize,
      llmConcurrency: recoveryRuntime?.concurrency || latestJob.llmConcurrency,
      llmFallbackModels: recoveryRuntime?.fallbackModels || latestJob.llmFallbackModels,
      llmRequestRetries: 0,
      llmRequestRetryProgressMark: '',
      llmRateLimitRetries: 0,
      llmRateLimitRetryProgressMark: '',
      llmValidationRetries: 0,
      llmValidationRetryProgressMark: '',
      nextAttemptAt: now(),
      error: '',
      progress: {
        ...recoveryProgress,
        currentStep: '迁移到最新 Workflow',
        message: savedCache
          ? '已保留服务器缓存，正在迁移到最新 Workflow 继续处理…'
          : '旧任务缓存不存在，正在由服务器重新生成这一份…',
      },
    }, snapshot.etag)
    if (recoveryRuntime) {
      const latestPayload = await readJobPayload(job.id).catch(() => null)
      if (latestPayload) {
        await writeJsonObject({
          key: jobPayloadKey(job.id),
          value: {
            ...latestPayload,
            llmModel: recoveryRuntime.model,
            llmBatchSize: recoveryRuntime.batchSize,
            llmConcurrency: recoveryRuntime.concurrency,
            llmFallbackModels: recoveryRuntime.fallbackModels,
          },
        })
      }
    }
    migratedJobs.push(migrated.job)
  }

  return migratedJobs
    .sort((left, right) => Number(left.copyIndex || 0) - Number(right.copyIndex || 0))
    .map(summarizeJob)
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
        ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode), job.wordCount || 0)),
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
      ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || [], job.wordCount || 0, job.generationMode), job.wordCount || 0)),
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

export const reexportWorksheetJob = async (jobId) => {
  const job = await readJob(jobId)
  if (!['completed', 'failed'].includes(job.status)) {
    const error = new Error('该任务仍在处理中，暂时无法重新导出。')
    error.statusCode = 409
    throw error
  }
  const payload = await readJobPayload(jobId).catch(() => null)
  if (!payload) {
    const error = new Error('找不到该任务的数据，无法重新导出。')
    error.statusCode = 404
    throw error
  }
  const cache = await getObjectJson({ key: jobCacheKey(jobId) }).catch(() => null)
  if (!cache) {
    const error = new Error('该任务的 LLM 缓存已清理，请重新生成。')
    error.statusCode = 409
    throw error
  }
  const result = await generateWorksheetArchive({
    rows: payload.rows || [],
    fileName: payload.fileName || job.fileName || '词组练习.xlsx',
    questionTypes: payload.questionTypes || job.questionTypes,
    generationMode: payload.generationMode || job.generationMode || GENERATION_MODE_FIXED_TEST_PAPER,
    llmModel: payload.llmModel || job.llmModel || getDefaultLlmModel(),
    llmBatchSize: payload.llmBatchSize || job.llmBatchSize,
    llmConcurrency: payload.llmConcurrency || job.llmConcurrency,
    llmFallbackModels: payload.llmFallbackModels || job.llmFallbackModels,
    variationSeed: payload.variationSeed || job.variationSeed || '',
    exportSuffix: payload.exportSuffix || job.exportSuffix || '',
    legacyQuestionCount: payload.legacyQuestionCount || job.legacyQuestionCount,
    testPaperGroupSizes: payload.testPaperGroupSizes || job.testPaperGroupSizes,
    withChineseTranslation: normalizeWithChineseTranslation(payload.withChineseTranslation ?? job.withChineseTranslation),
    initialCache: cache,
  })
  return {
    job: summarizeJob(job),
    buffer: result.buffer,
    fileName: result.fileName,
  }
}
