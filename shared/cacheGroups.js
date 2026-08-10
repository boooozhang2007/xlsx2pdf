export const getCacheJobIds = (job) => (
  [...new Set(
    (Array.isArray(job?.cacheJobIds) && job.cacheJobIds.length ? job.cacheJobIds : [job?.id])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
)

export const dedupeCacheJobs = (jobs = []) => {
  const uniqueBySignature = new Map()
  jobs
    .filter((job) => job?.cacheReady)
    .toSorted((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    .forEach((job) => {
      const batchId = String(job.batchId || '').trim()
      const signature = batchId ? `batch:${batchId}` : job.cacheSignature || job.id
      const existing = uniqueBySignature.get(signature)
      if (!existing) {
        uniqueBySignature.set(signature, {
          ...job,
          cacheJobIds: [job.id],
        })
      } else if (batchId) {
        existing.cacheJobIds = getCacheJobIds({
          cacheJobIds: [...getCacheJobIds(existing), job.id],
        })
      }
    })
  return [...uniqueBySignature.values()].toSorted(
    (left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0),
  )
}
