import crypto from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { generateWorksheetArchive } from './genEngine.js'
import { createGetUrl, getObjectBuffer, getObjectJson, listObjects, putObject } from './r2.js'

const JOB_PREFIX = 'worksheet-jobs'
const STALE_PROCESSING_MS = 1000 * 60 * 8
const MAX_LIST_JOBS = 40

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
  wordCount: job.wordCount || 0,
  questionTypes: job.questionTypes || [],
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

const createProgress = (totalSteps) => ({
  totalSteps,
  completedSteps: 0,
  currentStep: '',
  message: '已入队，等待服务器处理。',
  percent: 0,
})

const buildTotalSteps = (questionTypes) => {
  const needsLexical = questionTypes.some((key) => ['一_释义匹配', '二_选择题', '三_同义替换', '六_同义反义辨析', '七_同义词匹配', '八_反义词匹配', '九_判断正误'].includes(key))
  const needsBasicMaterials = questionTypes.some((key) => ['二_选择题', '九_判断正误'].includes(key))
  const needsSynonymMaterials = questionTypes.includes('三_同义替换')
  return questionTypes.length + (needsLexical ? 1 : 0) + (needsBasicMaterials ? 1 : 0) + (needsSynonymMaterials ? 1 : 0)
}

const progressFromMessage = (job, message) => {
  const progress = {
    ...(job.progress || createProgress(buildTotalSteps(job.questionTypes || []))),
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
        progress.percent = progress.totalSteps ? Math.round((progress.completedSteps / progress.totalSteps) * 100) : 0
      }
      return progress
    }
  }
  if (/\[.+\] 开始生成 /.test(message)) {
    progress.percent = progress.totalSteps ? Math.round((progress.completedSteps / progress.totalSteps) * 100) : 0
    return progress
  }
  if (/^\s*✓ /.test(message)) {
    progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + 1)
    progress.percent = progress.totalSteps ? Math.round((progress.completedSteps / progress.totalSteps) * 100) : 0
    return progress
  }
  if (/预热 LLM 词汇关系|预热 LLM 基础题面材料|预热 LLM 同义替换题面材料/.test(message)) {
    progress.completedSteps = Math.min(progress.totalSteps, progress.completedSteps + 1)
    progress.percent = progress.totalSteps ? Math.round((progress.completedSteps / progress.totalSteps) * 100) : 0
  }
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

const listJobStates = async () => {
  const objects = await listObjects({ prefix: `${JOB_PREFIX}/` })
  const jobKeys = objects
    .map((item) => item.Key)
    .filter((key) => key?.endsWith('/job.json'))
  const jobs = await Promise.all(jobKeys.map((key) => getObjectJson({ key }).catch(() => null)))
  return jobs
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
  const payload = await readJobPayload(job.id)
  let liveJob = await writeJob({
    ...job,
    status: 'processing',
    startedAt: job.startedAt || now(),
    error: '',
  })

  try {
    const result = await generateWorksheetArchive({
      rows: payload.rows || [],
      fileName: payload.fileName || '词组练习.xlsx',
      questionTypes: payload.questionTypes || job.questionTypes,
      onProgress: async (message) => {
        liveJob = await writeJob({
          ...liveJob,
          progress: progressFromMessage(liveJob, message),
        })
      },
    })

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
        ...(liveJob.progress || createProgress(buildTotalSteps(job.questionTypes || []))),
        completedSteps: buildTotalSteps(job.questionTypes || []),
        currentStep: '打包完成',
        message: '练习包已生成，可直接下载。',
        percent: 100,
      },
    })
  } catch (error) {
    await writeJob({
      ...liveJob,
      status: 'failed',
      failedAt: now(),
      error: error.message || '生成失败。',
      progress: {
        ...(liveJob.progress || createProgress(buildTotalSteps(job.questionTypes || []))),
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

export const submitWorksheetJob = async ({ rows, fileName, questionTypes }) => {
  const id = crypto.randomUUID()
  const submittedAt = now()
  const totalSteps = buildTotalSteps(questionTypes)
  const job = {
    id,
    fileName: String(fileName || '词组练习.xlsx'),
    questionTypes,
    createdAt: submittedAt,
    submittedAt,
    updatedAt: submittedAt,
    status: 'queued',
    wordCount: Array.isArray(rows) ? rows.length : 0,
    progress: createProgress(totalSteps),
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
