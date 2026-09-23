import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeRequest, createFakeResponse, readJsonResponse } from './helpers/fakeHttp.js'

process.env.TTS_ACCESS_PASSWORD = 'correct-password'
process.env.TTS_SESSION_SECRET = 'test-session-secret'
process.env.SHARE_SIGNING_SECRET = 'test-share-secret'
// 显式清空 R2 配置，验证限流存储不可用时登录仍可正常进行（fail-open）。
delete process.env.R2_ENDPOINT
delete process.env.R2_BUCKET
delete process.env.R2_ACCESS_KEY_ID
delete process.env.R2_SECRET_ACCESS_KEY

const authHandler = (await import('../server/handlers/auth/index.js')).default

const callLogin = async (password) => {
  const req = createFakeRequest({ method: 'POST', url: '/api/auth?action=login', body: { password } })
  const res = createFakeResponse()
  await authHandler(req, res)
  return readJsonResponse(res)
}

test('正确口令登录成功并下发会话 Cookie', async () => {
  const response = await callLogin('correct-password')
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /^tts_session=/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
})

test('错误口令返回 401', async () => {
  const response = await callLogin('wrong-password')
  assert.equal(response.status, 401)
  assert.equal(response.payload.ok, false)
})

test('R2 未配置时限流存储故障不会阻断登录', async () => {
  // 连续失败超过阈值：正常实现会进入锁定，但存储不可用时必须放行而不是锁死。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await callLogin('wrong-password')
  }
  const response = await callLogin('correct-password')
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
})
