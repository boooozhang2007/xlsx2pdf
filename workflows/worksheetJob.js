import { sleep } from 'workflow'
import { failWorksheetJobStart, processWorksheetJobAttempt } from '../server/genQueue.js'

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled']

async function runWorksheetJobAttempt(jobId) {
  'use step'
  return processWorksheetJobAttempt(jobId)
}

runWorksheetJobAttempt.maxRetries = 20

async function stopWorksheetJobBatch(jobIds, failedCopyIndex, message) {
  'use step'
  const reason = `批次因第 ${failedCopyIndex} 份失败而停止：${message || '生成失败。'}`
  await Promise.all(jobIds.map((jobId) => failWorksheetJobStart(jobId, reason)))
}

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

  for (let index = 0; index < jobIds.length; index += 1) {
    const jobId = jobIds[index]
    while (true) {
      const job = await runWorksheetJobAttempt(jobId)
      if (job.status === 'failed') {
        await stopWorksheetJobBatch(jobIds.slice(index + 1), index + 1, job.error || job.progress?.message)
        return job
      }
      if (TERMINAL_STATUSES.includes(job.status)) break

      const delayMs = Math.max(1000, Number(job.resumeAt || 0) - Date.now())
      await sleep(delayMs)
    }
  }
}
