import assert from 'node:assert/strict'
import test from 'node:test'
import { createShareToken, signShare, verifyShareToken } from '../server/auth.js'

process.env.SHARE_SIGNING_SECRET = 'test-share-signing-secret'

const SHARE_ID = '3f7c1a90-1d2e-4b3c-8a55-9e0f1b2c3d4e'
const PREFIX = `tts-shares/${SHARE_ID}`
const MANIFEST_KEY = `${PREFIX}/manifest.json`
const FUTURE = () => Date.now() + 60_000

const buildLegacyToken = ({ key, expiresAt }) => {
  const payload = Buffer.from(JSON.stringify({ key, expiresAt }), 'utf8').toString('base64url')
  return `${payload}.${signShare(payload)}`
}

test('播放 token 绑定 manifest，上传 token 绑定前缀', () => {
  const listen = createShareToken({ key: MANIFEST_KEY, expiresAt: FUTURE(), purpose: 'listen' })
  const upload = createShareToken({ key: PREFIX, expiresAt: FUTURE(), purpose: 'upload' })

  assert.equal(verifyShareToken(listen, { purpose: 'listen' })?.key, MANIFEST_KEY)
  assert.equal(verifyShareToken(upload, { purpose: 'upload' })?.key, PREFIX)
})

test('不同用途的 token 不能互相冒充', () => {
  const upload = createShareToken({ key: PREFIX, expiresAt: FUTURE(), purpose: 'upload' })
  const listen = createShareToken({ key: MANIFEST_KEY, expiresAt: FUTURE(), purpose: 'listen' })

  assert.equal(verifyShareToken(upload, { purpose: 'listen' }), null)
  assert.equal(verifyShareToken(listen, { purpose: 'upload' }), null)
})

test('历史 token 没有 purpose 字段时仍可用于播放', () => {
  // 兼容本次修复前已发出的二维码链接：payload 中不含 purpose。
  const legacy = buildLegacyToken({ key: MANIFEST_KEY, expiresAt: FUTURE() })
  assert.equal(verifyShareToken(legacy, { purpose: 'listen', allowLegacy: true })?.key, MANIFEST_KEY)
  // 但没有 purpose 的旧 token 不能用作上传凭证，也不能绕过严格校验。
  assert.equal(verifyShareToken(legacy, { purpose: 'upload' }), null)
  assert.equal(verifyShareToken(legacy, { purpose: 'listen' }), null)
})

test('过期与篡改的 token 一律拒绝', () => {
  const expired = createShareToken({ key: PREFIX, expiresAt: Date.now() - 1000, purpose: 'upload' })
  assert.equal(verifyShareToken(expired, { purpose: 'upload' }), null)

  const valid = createShareToken({ key: PREFIX, expiresAt: FUTURE(), purpose: 'upload' })
  const [payload, signature] = valid.split('.')
  assert.equal(verifyShareToken(`${payload}.${signature.slice(0, -2)}xy`, { purpose: 'upload' }), null)
  assert.equal(verifyShareToken('not-a-token', { purpose: 'upload' }), null)
  assert.equal(verifyShareToken('', { purpose: 'upload' }), null)
})
