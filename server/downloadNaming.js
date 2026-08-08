import { GENERATION_MODE_FIXED_TEST_PAPER, normalizeTestPaperGroupSizes } from '../shared/generationModes.js'

const stripZipExtension = (value) => String(value || '').replace(/\.zip$/i, '')

export const getSingleTestPaperGroupLabel = (job) => {
  if (job?.generationMode !== GENERATION_MODE_FIXED_TEST_PAPER) return ''
  const groupSizes = normalizeTestPaperGroupSizes(job.testPaperGroupSizes)
  if (groupSizes.length !== 1) return ''
  return groupSizes[0] ? `${groupSizes[0]}词一组` : '全部单词一组'
}

export const getWorksheetDownloadFileName = (job, preferredName = '') => {
  const fallbackName = `${String(job?.fileName || '词汇练习').replace(/\.[^.]+$/, '')}.zip`
  const fileName = preferredName || job?.exportFileName || fallbackName
  const groupLabel = getSingleTestPaperGroupLabel(job)
  if (!groupLabel) return fileName
  const stem = stripZipExtension(fileName)
  return `${stem.endsWith(groupLabel) ? stem : `${stem} ${groupLabel}`}.zip`
}

export const getBatchDownloadFileName = (jobs) => {
  const fileNames = [...new Set((jobs || []).map((job) => String(job?.fileName || '').trim()).filter(Boolean))]
  const base = fileNames.length === 1
    ? fileNames[0].replace(/\.[^.]+$/, '')
    : '词汇练习'
  return `${base || '词汇练习'} 批量下载 ${jobs.length}份.zip`
}
