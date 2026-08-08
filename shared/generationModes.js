export const GENERATION_MODE_FIXED_TEST_PAPER = 'fixed_test_paper'
export const GENERATION_MODE_LEGACY_ZIP = 'legacy_zip'

export const DEFAULT_LEGACY_QUESTION_COUNT = 30
export const TEST_PAPER_GROUP_SIZE_OPTIONS = [
  { value: 20, label: '20 词一组' },
  { value: 50, label: '50 词一组' },
  { value: 100, label: '100 词一组' },
  { value: 500, label: '500 词一组' },
  { value: 0, label: '全部单词一组' },
]

export const normalizeLegacyQuestionCount = (value) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : DEFAULT_LEGACY_QUESTION_COUNT
}

export const normalizeWithChineseTranslation = (value) => value !== false && value !== 'false' && value !== 0

export const normalizeTestPaperGroupSizes = (values) => {
  const allowed = new Set(TEST_PAPER_GROUP_SIZE_OPTIONS.map((item) => item.value))
  const source = Array.isArray(values) ? values : [values]
  const normalized = source.map((value) => Number.parseInt(value, 10)).filter((value) => allowed.has(value))
  return [...new Set(normalized.length ? normalized : [100])]
}

export const GENERATION_MODE_OPTIONS = [
  {
    key: GENERATION_MODE_FIXED_TEST_PAPER,
    title: '测试卷',
  },
  {
    key: GENERATION_MODE_LEGACY_ZIP,
    title: '练习包',
  },
]
