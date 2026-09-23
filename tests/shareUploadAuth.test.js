import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeRequest, createFakeResponse, readJsonResponse } from './helpers/fakeHttp.js'

process.env.TTS_ACCESS_PASSWORD = 'test-password'
process.env.TTS_SESSION_SECRET = 'test-session-secret'
process.env.SHARE_SIGNING_SECRET = 'test-share-secret'

const SHARE_ID = '3f7c1a90-1d2e-4b3c-8a55-9e0f1b2c3d4e'
const PREFIX = `tts-shares/${SHARE_ID}`
const OTHER_PREFIX = 'tts-shares/11111111-2222-3333-4444-555555555555'

const { createShareToken, createSessionCookie } = await import('../server/auth.js')
const uploadHandler = (await import('../server/handlers/share/upload.js')).default

const sessionCookie = createSessionCookie().split(';')[0]

const post = async (body) => {
  const req = createFakeRequest({ method: 'POST', url: '/api/share/upload', cookie: sessionCookie, body })
  const res = createFakeResponse()
  await uploadHandler(req, res)
  return readJsonResponse(res)
}

test('缺少上传凭证时拒绝写入', async () => {
  const response = await post({ key: `${PREFIX}/manifest.json`, contentType: 'application/json', text: '{}' })
  assert.equal(response.status, 403)
  assert.match(response.payload.error, /上传凭证/)
})

test('上传凭证不能写到其他分享前缀', async () => {
  const uploadToken = createShareToken({ key: PREFIX, expiresAt: Date.now() + 60_000, purpose: 'upload' })
  const response = await post({
    key: `${OTHER_PREFIX}/manifest.json`,
    contentType: 'application/json',
    uploadToken,
    text: '{}',
  })
  assert.equal(response.status, 403)
  assert.match(response.payload.error, /不属于本次分享/)
})

test('上传凭证不能写到分享目录之外', async () => {
  const uploadToken = createShareToken({ key: PREFIX, expiresAt: Date.now() + 60_000, purpose: 'upload' })
  const response = await post({
    key: 'worksheet-jobs/abc/artifact.zip',
    contentType: 'application/json',
    uploadToken,
    text: '{}',
  })
  assert.equal(response.status, 403)
})

test('播放 token 不能当作上传凭证', async () => {
  const listenToken = createShareToken({
    key: `${PREFIX}/manifest.json`,
    expiresAt: Date.now() + 60_000,
    purpose: 'listen',
  })
  const response = await post({
    key: `${PREFIX}/manifest.json`,
    contentType: 'application/json',
    uploadToken: listenToken,
    text: '{}',
  })
  assert.equal(response.status, 403)
})

test('内容类型与目标文件不匹配时拒绝', async () => {
  const uploadToken = createShareToken({ key: PREFIX, expiresAt: Date.now() + 60_000, purpose: 'upload' })
  const response = await post({
    key: `${PREFIX}/001_cheat-to-energy_30w/001_cheat.mp3`,
    contentType: 'text/html',
    uploadToken,
    base64: Buffer.from('<script/>').toString('base64'),
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /内容类型/)
})

test('超出体积上限时拒绝', async () => {
  const uploadToken = createShareToken({ key: PREFIX, expiresAt: Date.now() + 60_000, purpose: 'upload' })
  const response = await post({
    key: `${PREFIX}/001_cheat-to-energy_30w/001_cheat.mp3`,
    contentType: 'audio/mpeg',
    uploadToken,
    base64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'),
  })
  assert.equal(response.status, 413)
})

test('未登录时先被会话校验拦下', async () => {
  const req = createFakeRequest({ method: 'POST', url: '/api/share/upload', cookie: '', body: {} })
  const res = createFakeResponse()
  await uploadHandler(req, res)
  const response = readJsonResponse(res)
  assert.equal(response.status, 401)
})
