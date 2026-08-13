import assert from 'node:assert/strict'
import test from 'node:test'
import { splitWords } from '../src/ttsUtils.js'

test('splitWords 把换行、逗号和分号都当作分隔符并去掉序号', () => {
  assert.deepEqual(splitWords('1. apple, 2. banana; 3. cherry'), ['apple', 'banana', 'cherry'])
  assert.deepEqual(splitWords('cheat\nshare\npay phone'), ['cheat', 'share', 'pay phone'])
})

test('splitWords 不把词性变形括号里的分号当作分隔符', () => {
  assert.deepEqual(splitWords('oversleep v.(overslept ;overslept)'), ['oversleep'])
})

test('splitWords 清理词性 + 中文释义尾注', () => {
  assert.deepEqual(splitWords('share vt. 分享'), ['share'])
  assert.deepEqual(splitWords('energy n. 精力；力量'), ['energy', '力量'])
})
