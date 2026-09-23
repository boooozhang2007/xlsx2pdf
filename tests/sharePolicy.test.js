import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_AUDIO_BYTES,
  MAX_MANIFEST_BYTES,
  SHARE_KEY_RE,
  isContentTypeAllowedForKey,
  isKeyUnderPrefix,
  isManifestKey,
  isSharePrefix,
  maxBytesForKey,
  normalizeContentType,
} from '../server/sharePolicy.js'

const SHARE_ID = '3f7c1a90-1d2e-4b3c-8a55-9e0f1b2c3d4e'
const PREFIX = `tts-shares/${SHARE_ID}`

test('分享对象路径只接受 manifest 与批次音频两类形状', () => {
  assert.ok(SHARE_KEY_RE.test(`${PREFIX}/manifest.json`))
  assert.ok(SHARE_KEY_RE.test(`${PREFIX}/001_cheat-to-energy_30w/001_cheat.mp3`))
  assert.ok(!SHARE_KEY_RE.test(`${PREFIX}/../worksheet-jobs/abc/job.json`))
  assert.ok(!SHARE_KEY_RE.test(`${PREFIX}/001_batch/notes.txt`))
  assert.ok(!SHARE_KEY_RE.test(`tts-shares/not-a-uuid/manifest.json`))
  assert.ok(!SHARE_KEY_RE.test('worksheet-jobs/abc/job.json'))
  assert.ok(isSharePrefix(PREFIX))
  assert.ok(!isSharePrefix(`${PREFIX}/extra`))
})

test('上传目标必须落在凭证绑定的分享前缀内', () => {
  const other = `tts-shares/11111111-2222-3333-4444-555555555555`
  assert.ok(isKeyUnderPrefix(`${PREFIX}/manifest.json`, PREFIX))
  assert.ok(isKeyUnderPrefix(`${PREFIX}/001_a-b_2w/001_a.mp3`, PREFIX))
  // 拿着自己的上传凭证不能写到别人的分享里，也不能越出前缀。
  assert.ok(!isKeyUnderPrefix(`${other}/manifest.json`, PREFIX))
  assert.ok(!isKeyUnderPrefix(`worksheet-jobs/abc/artifact.zip`, PREFIX))
  assert.ok(!isKeyUnderPrefix(`${PREFIX}-suffix/manifest.json`, PREFIX))
  assert.ok(!isKeyUnderPrefix(`${PREFIX}/manifest.json`, 'tts-shares/not-a-uuid'))
})

test('只有 manifest 能被当作播放清单读取', () => {
  assert.ok(isManifestKey(`${PREFIX}/manifest.json`))
  assert.ok(!isManifestKey(`${PREFIX}/001_a-b_2w/001_a.mp3`))
  assert.ok(!isManifestKey(PREFIX))
})

test('内容类型按目标文件校验，避免写入任意 MIME 对象', () => {
  assert.ok(isContentTypeAllowedForKey(`${PREFIX}/manifest.json`, 'application/json; charset=utf-8'))
  assert.ok(!isContentTypeAllowedForKey(`${PREFIX}/manifest.json`, 'audio/mpeg'))
  assert.ok(isContentTypeAllowedForKey(`${PREFIX}/001_a-b_2w/001_a.mp3`, 'audio/mpeg'))
  assert.ok(!isContentTypeAllowedForKey(`${PREFIX}/001_a-b_2w/001_a.mp3`, 'text/html'))
  assert.equal(normalizeContentType('  Audio/MPEG ; charset=x '), 'audio/mpeg')
})

test('体积上限按对象类型区分', () => {
  assert.equal(maxBytesForKey(`${PREFIX}/manifest.json`), MAX_MANIFEST_BYTES)
  assert.equal(maxBytesForKey(`${PREFIX}/001_a-b_2w/001_a.mp3`), MAX_AUDIO_BYTES)
  assert.ok(MAX_MANIFEST_BYTES < MAX_AUDIO_BYTES)
})
