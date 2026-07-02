import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { listWorksheetJobs, scheduleWorksheetJobQueue, submitWorksheetJob } from '../../server/genQueue.js'
import { ALL_QUESTION_TYPE_KEYS } from '../../shared/worksheetTypes.js'

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method || '')) return rejectMethod(res, 'GET, POST')
  if (!requireSession(req, res)) return

  try {
    if (req.method === 'GET') {
      const jobs = await listWorksheetJobs()
      if (jobs.some((job) => ['queued', 'processing'].includes(job.status))) {
        scheduleWorksheetJobQueue()
      }
      return sendJson(res, 200, { ok: true, jobs })
    }

    const body = await readJsonBody(req)
    const rows = Array.isArray(body.rows) ? body.rows : null
    if (!rows) {
      return sendJson(res, 400, { ok: false, error: 'rows 必须是数组。' })
    }

    const questionTypes = Array.isArray(body.questionTypes) && body.questionTypes.length
      ? body.questionTypes
      : ALL_QUESTION_TYPE_KEYS

    const job = await submitWorksheetJob({
      rows,
      fileName: body.fileName || body.title || '词组练习.xlsx',
      questionTypes,
    })
    scheduleWorksheetJobQueue()
    return sendJson(res, 200, { ok: true, job })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '创建任务失败。' })
  }
}
