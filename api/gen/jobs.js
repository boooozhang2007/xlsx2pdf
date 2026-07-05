import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { cancelWorksheetJob, deleteWorksheetJob, listWorksheetJobs, scheduleWorksheetJobQueue, submitWorksheetJob } from '../../server/genQueue.js'
import { getAvailableLlmModels, getDefaultLlmModel } from '../../server/genEngine.js'
import { ALL_QUESTION_TYPE_KEYS, FIXED_TEST_PAPER_QUESTION_KEYS } from '../../shared/worksheetTypes.js'
import { GENERATION_MODE_FIXED_TEST_PAPER, GENERATION_MODE_LEGACY_ZIP } from '../../shared/generationModes.js'

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) return rejectMethod(res, 'GET, POST, DELETE')
  if (!requireSession(req, res)) return

  try {
    if (req.method === 'GET') {
      const jobs = await listWorksheetJobs()
      if (jobs.some((job) => ['queued', 'processing'].includes(job.status))) {
        scheduleWorksheetJobQueue()
      }
      return sendJson(res, 200, {
        ok: true,
        jobs,
        llmModels: getAvailableLlmModels(),
        defaultLlmModel: getDefaultLlmModel(),
      })
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

    const job = await submitWorksheetJob({
      rows,
      fileName: body.fileName || body.title || '词组练习.xlsx',
      questionTypes,
      generationMode,
      llmModel: body.llmModel || getDefaultLlmModel(),
    })
    scheduleWorksheetJobQueue()
    return sendJson(res, 200, { ok: true, job })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '创建任务失败。' })
  }
}
