import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupeCacheJobs, getCacheJobIds } from '../shared/cacheGroups.js'

test('identical cache copies are listed once using the original cache job', () => {
  const jobs = [
    { id: 'copied', cacheReady: true, cacheSignature: 'same-cache', createdAt: 200 },
    { id: 'original', cacheReady: true, cacheSignature: 'same-cache', createdAt: 100 },
    { id: 'expanded', cacheReady: true, cacheSignature: 'expanded-cache', createdAt: 300 },
    { id: 'no-cache', cacheReady: false, createdAt: 400 },
  ]

  assert.deepEqual(dedupeCacheJobs(jobs).map((job) => job.id), ['expanded', 'original'])
})

test('batch copies are listed as one cache group even when their cache files diverge', () => {
  const jobs = [
    { id: 'copy-3', batchId: 'batch-a', cacheReady: true, cacheSignature: 'cache-c', createdAt: 300 },
    { id: 'copy-2', batchId: 'batch-a', cacheReady: true, cacheSignature: 'cache-b', createdAt: 200 },
    { id: 'copy-1', batchId: 'batch-a', cacheReady: true, cacheSignature: 'cache-a', createdAt: 100 },
    { id: 'other', batchId: 'batch-b', cacheReady: true, cacheSignature: 'cache-d', createdAt: 400 },
  ]

  const deduped = dedupeCacheJobs(jobs)
  assert.deepEqual(deduped.map((job) => job.id), ['other', 'copy-1'])
  assert.deepEqual(getCacheJobIds(deduped[1]), ['copy-1', 'copy-2', 'copy-3'])
})
