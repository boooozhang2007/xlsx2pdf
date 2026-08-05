import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTemplatePageCapacity,
  paginateTemplateRows,
} from '../src/templateLayout.js'

test('the final configured template page keeps a full-page capacity', () => {
  assert.equal(getTemplatePageCapacity(55), 40)
})

test('2200 rows stay on 56 normally sized template pages', () => {
  const rows = Array.from({ length: 2200 }, (_, index) => ({
    english: `word-${index + 1}`,
    chinese: `meaning-${index + 1}`,
  }))

  const pages = paginateTemplateRows(rows)
  const lastPage = pages.at(-1)

  assert.equal(pages.length, 56)
  assert.equal(lastPage.startIndex, 2165)
  assert.equal(lastPage.endIndex, 2200)
  assert.equal(lastPage.capacity, 40)
  assert.equal(lastPage.rows.length, 36)
})
