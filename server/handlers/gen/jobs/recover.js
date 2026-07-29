import { getRun, start } from 'workflow/api'
import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../../auth.js'
import { prepareWorksheetBatchWorkflowMigration } from '../../../genQueue.js'
import { worksheetJobBatchWorkflow } from '../../../../workflows/worksheetJob.js'

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const batchId = String(body.batchId || '').trim()
    const previousRunId = String(body.runId || '').trim()
    if (!batchId) {
      return sendJson(res, 400, { ok: false, error: '缺少 batchId。' })
    }

    let previousRunStatus = 'not_provided'
    if (previousRunId) {
      const previousRun = getRun(previousRunId)
      const previousRunExists = await previousRun.exists
      previousRunStatus = previousRunExists ? await previousRun.status : 'not_found'
      if (previousRunExists && !TERMINAL_RUN_STATUSES.has(previousRunStatus)) {
        await previousRun.cancel()
      }
    }

    const jobs = await prepareWorksheetBatchWorkflowMigration(batchId)
    const run = await start(
      worksheetJobBatchWorkflow,
      [jobs.map((job) => job.id)],
      { deploymentId: 'latest' },
    )
    return sendJson(res, 200, {
      ok: true,
      batchId,
      previousRunId,
      previousRunStatus,
      workflowRunId: run.runId,
      jobs,
    }, { 'cache-control': 'no-store' })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || '迁移 Workflow 失败。',
    })
  }
}
