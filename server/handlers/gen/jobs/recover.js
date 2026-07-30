import { getRun, start } from 'workflow/api'
import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../../auth.js'
import { prepareWorksheetBatchWorkflowMigration, seedWorksheetJobCaches } from '../../../genQueue.js'
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

    const seedCacheFromJobIds = [
      ...(Array.isArray(body.seedCacheFromJobIds) ? body.seedCacheFromJobIds : []),
      body.seedCacheFromJobId,
    ].map((value) => String(value || '').trim()).filter(Boolean)
    const seedCacheToJobId = String(body.seedCacheToJobId || '').trim()
    if (Boolean(seedCacheFromJobIds.length) !== Boolean(seedCacheToJobId)) {
      return sendJson(res, 400, { ok: false, error: '缓存恢复需要同时提供源任务和目标任务 id。' })
    }
    const jobs = await prepareWorksheetBatchWorkflowMigration(batchId, {
      resetRuntime: body.resetRuntime === true,
    })
    // Migration invalidates the old execution lease before the cache is
    // merged, so an in-flight canceled step cannot overwrite the recovery.
    const seededCache = seedCacheFromJobIds.length
      ? await seedWorksheetJobCaches(seedCacheFromJobIds, seedCacheToJobId)
      : null
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
      seededCache,
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
