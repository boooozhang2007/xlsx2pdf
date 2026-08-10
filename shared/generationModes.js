export const GENERATION_MODE_FIXED_TEST_PAPER = 'fixed_test_paper'
export const GENERATION_MODE_LEGACY_ZIP = 'legacy_zip'

export const GENERATION_PRESET_PRIMARY = 'primary_school'
export const GENERATION_PRESET_SECONDARY = 'secondary_school'

export const DEFAULT_LEGACY_QUESTION_COUNT = 30
export const DEFAULT_LEGACY_GROUP_SIZE = 50
export const DEFAULT_TEST_PAPER_QUESTION_COUNT = 30
export const GENERATION_PRESET_OPTIONS = [
  {
    key: GENERATION_PRESET_PRIMARY,
    title: '小学',
    description: '第一大题含中文 · 测试卷每大题及练习包均按 20/20 全抽',
    withChineseTranslation: true,
    legacyGroupSize: 20,
    legacyQuestionCount: 20,
    testPaperGroupSizes: [20],
    testPaperQuestionCount: 20,
  },
  {
    key: GENERATION_PRESET_SECONDARY,
    title: '初高中',
    description: '使用现有默认参数 · 第一大题不含中文',
    withChineseTranslation: false,
    legacyGroupSize: DEFAULT_LEGACY_GROUP_SIZE,
    legacyQuestionCount: DEFAULT_LEGACY_QUESTION_COUNT,
    testPaperGroupSizes: [100],
    testPaperQuestionCount: DEFAULT_TEST_PAPER_QUESTION_COUNT,
  },
]
export const TEST_PAPER_GROUP_SIZE_OPTIONS = [
  { value: 20, label: '20 词一组' },
  { value: 50, label: '50 词一组' },
  { value: 100, label: '100 词一组' },
  { value: 200, label: '200 词一组' },
  { value: 500, label: '500 词一组' },
  { value: 0, label: '全部单词一组' },
]

export const normalizeLegacyQuestionCount = (value) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : DEFAULT_LEGACY_QUESTION_COUNT
}

export const normalizeLegacyGroupSize = (value) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(2500, parsed)) : DEFAULT_LEGACY_GROUP_SIZE
}

export const normalizeTestPaperQuestionCount = (value) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : DEFAULT_TEST_PAPER_QUESTION_COUNT
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
