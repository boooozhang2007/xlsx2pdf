import test from 'node:test'
import assert from 'node:assert/strict'
import { dedupeCacheJobs } from '../shared/cacheGroups.js'

test('identical cache copies are listed once using the original cache job', () => {
  const jobs = [
    { id: 'copied', cacheReady: true, cacheSignature: 'same-cache', createdAt: 200 },
    { id: 'original', cacheReady: true, cacheSignature: 'same-cache', createdAt: 100 },
    { id: 'expanded', cacheReady: true, cacheSignature: 'expanded-cache', createdAt: 300 },
    { id: 'no-cache', cacheReady: false, createdAt: 400 },
  ]

  assert.deepEqual(dedupeCacheJobs(jobs).map((job) => job.id), ['expanded', 'original'])
})
