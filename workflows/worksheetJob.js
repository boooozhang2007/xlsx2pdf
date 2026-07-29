import { sleep } from 'workflow'
import { processWorksheetJobAttempt } from '../server/genQueue.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled']

async function runWorksheetJobAttempt(jobId) {
  'use step'
  return processWorksheetJobAttempt(jobId)
}

runWorksheetJobAttempt.maxRetries = 20

export async function worksheetJobWorkflow(jobId) {
  'use workflow'

  while (true) {
    const job = await runWorksheetJobAttempt(jobId)
    if (TERMINAL_STATUSES.includes(job.status)) return job

    const delayMs = Math.max(1000, Number(job.resumeAt || 0) - Date.now())
    await sleep(delayMs)
  }
}

export async function worksheetJobBatchWorkflow(jobIds) {
  'use workflow'

  for (const jobId of jobIds) {
    while (true) {
      const job = await runWorksheetJobAttempt(jobId)
      if (TERMINAL_STATUSES.includes(job.status)) break

      const delayMs = Math.max(1000, Number(job.resumeAt || 0) - Date.now())
      await sleep(delayMs)
    }
  }
}
