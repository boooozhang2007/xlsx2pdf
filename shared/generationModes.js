export const GENERATION_MODE_FIXED_TEST_PAPER = 'fixed_test_paper'
export const GENERATION_MODE_LEGACY_ZIP = 'legacy_zip'

export const GENERATION_MODE_OPTIONS = [
  {
    key: GENERATION_MODE_FIXED_TEST_PAPER,
    title: '模板测试卷',
    description: '按 801-900 模板生成，每 100 词 1 份 docx，答案附在文末。',
  },
  {
    key: GENERATION_MODE_LEGACY_ZIP,
    title: '当前格式 ZIP',
    description: '按原来的多题型结构重新打包成 ZIP，可按题型分别导出。',
  },
]
