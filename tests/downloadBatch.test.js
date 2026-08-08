import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStoredZipFiles, createZipBuffer } from '../server/zip.js'
import { getBatchDownloadFileName, getWorksheetDownloadFileName } from '../server/downloadNaming.js'
import { GENERATION_MODE_FIXED_TEST_PAPER, GENERATION_MODE_LEGACY_ZIP } from '../shared/generationModes.js'

test('generated ZIP files can be extracted for a flat batch archive', () => {
  const source = createZipBuffer([
    { name: '测试卷包/全部单词一组/1-30测试卷.docx', data: Buffer.from('first') },
    { name: '测试卷包/全部单词一组/答案.pdf', data: Buffer.from('second') },
  ])
  const files = extractStoredZipFiles(source)

  assert.deepEqual(files.map((file) => file.name), [
    '测试卷包/全部单词一组/1-30测试卷.docx',
    '测试卷包/全部单词一组/答案.pdf',
  ])
  assert.deepEqual(files.map((file) => file.data.toString()), ['first', 'second'])
})

test('single test-paper group downloads append the selected group label', () => {
  const allWordsJob = {
    fileName: '六年级词汇.xlsx',
    exportFileName: '六年级词汇 测试卷包 第01份.zip',
    generationMode: GENERATION_MODE_FIXED_TEST_PAPER,
    testPaperGroupSizes: [0],
  }
  const hundredWordJob = { ...allWordsJob, testPaperGroupSizes: [100] }
  const multiGroupJob = { ...allWordsJob, testPaperGroupSizes: [50, 100] }
  const practicePackJob = { ...allWordsJob, generationMode: GENERATION_MODE_LEGACY_ZIP }

  assert.equal(getWorksheetDownloadFileName(allWordsJob), '六年级词汇 测试卷包 第01份 全部单词一组.zip')
  assert.equal(getWorksheetDownloadFileName(hundredWordJob), '六年级词汇 测试卷包 第01份 100词一组.zip')
  assert.equal(getWorksheetDownloadFileName(multiGroupJob), allWordsJob.exportFileName)
  assert.equal(getWorksheetDownloadFileName(practicePackJob), allWordsJob.exportFileName)
})

test('batch download names use the shared source file and selected count', () => {
  const jobs = Array.from({ length: 10 }, () => ({ fileName: '六年级词汇.xlsx' }))
  assert.equal(getBatchDownloadFileName(jobs), '六年级词汇 批量下载 10份.zip')
})
