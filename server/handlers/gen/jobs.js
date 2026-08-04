import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import crypto from 'node:crypto'
import { start } from 'workflow/api'
import { cancelWorksheetJob, deleteWorksheetJob, failWorksheetJobStart, listWorksheetJobs, retryWorksheetJob, submitWorksheetJob } from '../../genQueue.js'
import { getAvailableLlmModels, getDefaultLlmModel } from '../../genEngine.js'
import { ALL_QUESTION_TYPE_KEYS, FIXED_TEST_PAPER_QUESTION_KEYS } from '../../../shared/worksheetTypes.js'
import { GENERATION_MODE_FIXED_TEST_PAPER, GENERATION_MODE_LEGACY_ZIP, normalizeWithChineseTranslation } from '../../../shared/generationModes.js'
import { worksheetJobBatchWorkflow, worksheetJobWorkflow } from '../../../workflows/worksheetJob.js'

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) return rejectMethod(res, 'GET, POST, DELETE')
  if (!requireSession(req, res)) return

  try {
    if (req.method === 'GET') {
      const jobs = await listWorksheetJobs()
      return sendJson(res, 200, {
        ok: true,
        jobs,
        llmModels: getAvailableLlmModels(),
        defaultLlmModel: getDefaultLlmModel(),
      }, { 'cache-control': 'no-store' })
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
      const body = req.headers['content-length'] ? await readJsonBody(req).catch(() => ({})) : {}
      const jobId = String(url.searchParams.get('id') || body.id || '').trim()
      const intent = String(url.searchParams.get('intent') || body.intent || '').trim().toLowerCase()
      if (!jobId) {
        return sendJson(res, 400, { ok: false, error: '缺少任务 id。' })
      }
      if (intent === 'delete') {
        await deleteWorksheetJob(jobId)
        return sendJson(res, 200, { ok: true })
      }
      const job = await cancelWorksheetJob(jobId)
      return sendJson(res, 200, { ok: true, job })
    }

    const body = await readJsonBody(req)
    const retryJobId = String(body.retryJobId || '').trim()
    if (retryJobId) {
      const retryQuestionTypes = Array.isArray(body.questionTypes)
        ? body.questionTypes.filter((key) => ALL_QUESTION_TYPE_KEYS.includes(key))
        : undefined
      const submission = await retryWorksheetJob(retryJobId, {
        questionTypes: retryQuestionTypes?.length ? retryQuestionTypes : undefined,
      })
      if (!submission.created) {
        return sendJson(res, 200, { ok: true, job: submission.job, jobs: [submission.job], deduplicated: true })
      }
      try {
        const run = await start(worksheetJobWorkflow, [submission.job.id])
        return sendJson(res, 200, { ok: true, job: submission.job, jobs: [submission.job], workflowRunId: run.runId })
      } catch (error) {
        await failWorksheetJobStart(submission.job.id, error.message || 'Workflow 启动失败。').catch(() => {})
        throw error
      }
    }
    const rows = Array.isArray(body.rows) ? body.rows : null
    if (!rows) {
      return sendJson(res, 400, { ok: false, error: 'rows 必须是数组。' })
    }

    const generationMode = body.generationMode === GENERATION_MODE_LEGACY_ZIP
      ? GENERATION_MODE_LEGACY_ZIP
      : GENERATION_MODE_FIXED_TEST_PAPER
    const questionTypes = generationMode === GENERATION_MODE_FIXED_TEST_PAPER
      ? FIXED_TEST_PAPER_QUESTION_KEYS
      : (Array.isArray(body.questionTypes) && body.questionTypes.length ? body.questionTypes : ALL_QUESTION_TYPE_KEYS)

    const copies = Math.max(1, Math.min(20, Number.parseInt(body.copies, 10) || 1))
    const batchId = copies > 1 ? crypto.randomUUID() : ''
    const submissions = []
    for (let index = 0; index < copies; index += 1) {
      submissions.push(await submitWorksheetJob({
        rows,
        fileName: body.fileName || body.title || '词组练习.xlsx',
        questionTypes,
        generationMode,
        llmModel: body.llmModel || getDefaultLlmModel(),
        legacyQuestionCount: body.legacyQuestionCount,
        testPaperGroupSizes: body.testPaperGroupSizes,
        withChineseTranslation: normalizeWithChineseTranslation(body.withChineseTranslation),
        batchId,
        copyIndex: copies > 1 ? index + 1 : 0,
        copyCount: copies,
        variationSeed: copies > 1 ? `${batchId}:${index + 1}` : '',
        exportSuffix: copies > 1 ? `第${String(index + 1).padStart(2, '0')}份` : '',
        allowDuplicate: copies > 1,
      }))
    }
    const jobs = submissions.map((item) => item.job)
    const createdJobs = submissions.filter((item) => item.created).map((item) => item.job)
    if (!createdJobs.length) {
      return sendJson(res, 200, { ok: true, job: jobs[0], jobs, deduplicated: true })
    }
    try {
      const run = copies > 1
        ? await start(worksheetJobBatchWorkflow, [createdJobs.map((job) => job.id)])
        : await start(worksheetJobWorkflow, [createdJobs[0].id])
      return sendJson(res, 200, { ok: true, job: jobs[0], jobs, workflowRunId: run.runId })
    } catch (error) {
      await Promise.all(createdJobs.map((job) => (
        failWorksheetJobStart(job.id, error.message || 'Workflow 启动失败。').catch(() => {})
      )))
      throw error
    }
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '创建任务失败。' })
  }
}
