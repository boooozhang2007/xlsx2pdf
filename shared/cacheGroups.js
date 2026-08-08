export const dedupeCacheJobs = (jobs = []) => {
  const uniqueBySignature = new Map()
  jobs
    .filter((job) => job?.cacheReady)
    .toSorted((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    .forEach((job) => {
      const signature = job.cacheSignature || job.id
      if (!uniqueBySignature.has(signature)) uniqueBySignature.set(signature, job)
    })
  return [...uniqueBySignature.values()].toSorted(
    (left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0),
  )
}
