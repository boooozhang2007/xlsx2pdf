const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0))

export const getActionJobs = (job) => (
  Array.isArray(job?.batchJobs) && job.batchJobs.length ? job.batchJobs : [job].filter(Boolean)
)

const getBatchStatus = (jobs) => {
  const statuses = new Set(jobs.map((job) => job.status))
  if (statuses.has('canceling')) return 'canceling'
  if (statuses.has('processing')) return 'processing'
  if (statuses.has('queued')) return 'queued'
  if (statuses.has('failed')) return 'failed'
  if (jobs.every((job) => job.status === 'completed')) return 'completed'
  return statuses.has('canceled') ? 'canceled' : jobs[0]?.status || 'queued'
}

export const collapseBatchJobs = (jobs = []) => {
  const entries = []
  const batches = new Map()
  jobs.forEach((job) => {
    const batchId = String(job?.batchId || '').trim()
    if (!batchId) {
      entries.push({ jobs: [job] })
      return
    }
    if (!batches.has(batchId)) {
      const entry = { jobs: [] }
      batches.set(batchId, entry)
      entries.push(entry)
    }
    batches.get(batchId).jobs.push(job)
  })

  return entries.map(({ jobs: batchJobs }) => {
    if (batchJobs.length === 1) return batchJobs[0]
    const representative = batchJobs.find((job) => ['processing', 'canceling'].includes(job.status)) || batchJobs[0]
    const totalWords = batchJobs.reduce((sum, job) => sum + (Number(job.wordCount) || 0), 0)
    const completedWords = batchJobs.reduce((sum, job) => (
      sum + Math.round((Number(job.wordCount) || 0) * clampPercent(job.progress?.percent || 0) / 100)
    ), 0)
    const percent = totalWords ? Math.round(completedWords / totalWords * 100) : 0
    return {
      ...representative,
      id: `batch:${representative.batchId}`,
      status: getBatchStatus(batchJobs),
      batchJobs,
      copyIndex: 0,
      copyCount: Math.max(batchJobs.length, ...batchJobs.map((job) => Number(job.copyCount) || 1)),
      wordCount: totalWords,
      artifactReady: batchJobs.every((job) => job.status === 'completed' && job.artifactReady),
      updatedAt: Math.max(...batchJobs.map((job) => Number(job.updatedAt || job.createdAt) || 0)),
      error: batchJobs.find((job) => job.error)?.error || '',
      progress: {
        ...(representative.progress || {}),
        percent,
        stageWordTotal: totalWords,
        stageWordCompleted: completedWords,
      },
    }
  })
}
