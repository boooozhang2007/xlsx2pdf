export const QUESTION_TYPE_OPTIONS = [
  {
    key: '一_释义匹配',
    title: '释义匹配',
    description: '根据英文释义匹配正确单词。',
    needsLlm: true,
  },
  {
    key: '二_选择题',
    title: '单词选择题',
    description: '根据句子语境做四选一。',
    needsLlm: true,
  },
  {
    key: '三_同义替换',
    title: '同义替换',
    description: '用同义词替换句中目标词。',
    needsLlm: true,
  },
  {
    key: '五_缺字母填空',
    title: '缺字母填空',
    description: '保留部分字母，让学生补完整个单词。',
    needsLlm: false,
  },
  {
    key: '六_同义反义辨析',
    title: '同反义辨析',
    description: '判断词对是同义还是反义。',
    needsLlm: true,
  },
  {
    key: '七_同义词匹配',
    title: '同义词匹配',
    description: '把左侧单词和右侧同义词配对。',
    needsLlm: true,
  },
  {
    key: '八_反义词匹配',
    title: '反义词匹配',
    description: '把左侧单词和右侧反义词配对。',
    needsLlm: true,
  },
  {
    key: '九_判断正误',
    title: '判断正误',
    description: '阅读句子并判断 T / F。',
    needsLlm: true,
  },
  {
    key: '十_汉译英',
    title: '汉译英',
    description: '按分栏版式输出汉译英选择题 PDF。',
    needsLlm: false,
  },
  {
    key: '十一_英译汉',
    title: '英译汉',
    description: '按分栏版式输出英译汉选择题 PDF。',
    needsLlm: false,
  },
]

export const ALL_QUESTION_TYPE_KEYS = QUESTION_TYPE_OPTIONS.map((item) => item.key)

export const FIXED_TEST_PAPER_QUESTION_KEYS = [
  '一_释义匹配',
  '二_选择题',
  '三_同义替换',
  '五_缺字母填空',
  '六_同义反义辨析',
  '七_同义词匹配',
  '八_反义词匹配',
  '九_判断正误',
]

export const FIXED_TEST_PAPER_SECTIONS = [
  { order: 1, key: '一_释义匹配', title: '释义匹配', countLabel: '10题', needsLlm: true },
  { order: 2, key: '二_选择题', title: '单项选择', countLabel: '10题', needsLlm: true },
  { order: 3, key: '三_同义替换', title: '同义替换', countLabel: '10题', needsLlm: true },
  { order: 4, key: '五_缺字母填空', title: '缺字母填空', countLabel: '10题', needsLlm: false },
  { order: 5, key: '六_同义反义辨析', title: '同义反义辨析', countLabel: '10题', needsLlm: true },
  { order: 6, key: '七_同义词匹配', title: '同义词匹配', countLabel: '1组5词', needsLlm: true },
  { order: 7, key: '八_反义词匹配', title: '反义词匹配', countLabel: '1组5词', needsLlm: true },
  { order: 8, key: '九_判断正误', title: '判断正误', countLabel: '10题', needsLlm: true },
]
