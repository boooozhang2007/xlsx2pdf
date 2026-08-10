import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GENERATION_PRESET_OPTIONS,
  GENERATION_PRESET_PRIMARY,
  GENERATION_PRESET_SECONDARY,
} from '../shared/generationModes.js'
import { collapseBatchJobs, getActionJobs } from '../shared/jobBatches.js'

test('generation presets keep primary and secondary defaults distinct', () => {
  const primary = GENERATION_PRESET_OPTIONS.find((preset) => preset.key === GENERATION_PRESET_PRIMARY)
  const secondary = GENERATION_PRESET_OPTIONS.find((preset) => preset.key === GENERATION_PRESET_SECONDARY)

  assert.deepEqual(
    [
      primary.withChineseTranslation,
      primary.legacyGroupSize,
      primary.legacyQuestionCount,
      primary.testPaperGroupSizes,
      primary.testPaperQuestionCount,
    ],
    [true, 20, 20, [20], 20],
  )
  assert.deepEqual(
    [
      secondary.withChineseTranslation,
      secondary.legacyGroupSize,
      secondary.legacyQuestionCount,
      secondary.testPaperGroupSizes,
      secondary.testPaperQuestionCount,
    ],
    [false, 50, 30, [100], 30],
  )
})

test('batch copies collapse into one actionable display record', () => {
  const batchJobs = [
    { id: 'copy-1', batchId: 'batch-a', status: 'completed', copyCount: 3, wordCount: 20, artifactReady: true, progress: { percent: 100 } },
    { id: 'copy-2', batchId: 'batch-a', status: 'processing', copyCount: 3, wordCount: 20, artifactReady: false, progress: { percent: 50 } },
    { id: 'copy-3', batchId: 'batch-a', status: 'queued', copyCount: 3, wordCount: 20, artifactReady: false, progress: { percent: 0 } },
  ]
  const standalone = { id: 'single', status: 'completed', wordCount: 20, artifactReady: true, progress: { percent: 100 } }
  const collapsed = collapseBatchJobs([...batchJobs, standalone])

  assert.equal(collapsed.length, 2)
  assert.equal(collapsed[0].id, 'batch:batch-a')
  assert.equal(collapsed[0].status, 'processing')
  assert.equal(collapsed[0].copyCount, 3)
  assert.equal(collapsed[0].progress.percent, 50)
  assert.equal(collapsed[0].artifactReady, false)
  assert.deepEqual(getActionJobs(collapsed[0]).map((job) => job.id), ['copy-1', 'copy-2', 'copy-3'])
  assert.equal(collapsed[1], standalone)
})

test('a completed batch exposes one downloadable record', () => {
  const collapsed = collapseBatchJobs([
    { id: 'copy-1', batchId: 'batch-b', status: 'completed', copyCount: 2, wordCount: 10, artifactReady: true, progress: { percent: 100 } },
    { id: 'copy-2', batchId: 'batch-b', status: 'completed', copyCount: 2, wordCount: 10, artifactReady: true, progress: { percent: 100 } },
  ])

  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].status, 'completed')
  assert.equal(collapsed[0].artifactReady, true)
  assert.equal(collapsed[0].progress.percent, 100)
})
