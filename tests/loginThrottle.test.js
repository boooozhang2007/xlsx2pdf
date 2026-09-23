import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCK_BASE_MS,
  LOGIN_LOCK_MAX_MS,
  computeLoginLockMs,
  describeLoginThrottle,
  getClientIdentity,
} from '../server/loginThrottle.js'

test('阈值以内不锁定，超过阈值后逐次加倍', () => {
  assert.equal(computeLoginLockMs(0), 0)
  assert.equal(computeLoginLockMs(LOGIN_FAILURE_THRESHOLD - 1), 0)
  assert.equal(computeLoginLockMs(LOGIN_FAILURE_THRESHOLD), LOGIN_LOCK_BASE_MS)
  assert.equal(computeLoginLockMs(LOGIN_FAILURE_THRESHOLD + 1), LOGIN_LOCK_BASE_MS * 2)
  assert.equal(computeLoginLockMs(LOGIN_FAILURE_THRESHOLD + 2), LOGIN_LOCK_BASE_MS * 4)
})

test('锁定时长封顶，不会无界增长', () => {
  assert.equal(computeLoginLockMs(LOGIN_FAILURE_THRESHOLD + 50), LOGIN_LOCK_MAX_MS)
})

test('锁定到期后自动放行', () => {
  const currentTime = 1_000_000
  assert.deepEqual(
    describeLoginThrottle({ failures: 6, lockedUntil: currentTime + 1000, updatedAt: currentTime }, currentTime),
    { failures: 6, lockedUntil: currentTime + 1000 },
  )
  assert.deepEqual(
    describeLoginThrottle({ failures: 6, lockedUntil: currentTime - 1, updatedAt: currentTime }, currentTime),
    { failures: 6, lockedUntil: 0 },
  )
})

test('长时间无失败后历史计数不再累计', () => {
  const currentTime = 10_000_000
  assert.deepEqual(
    describeLoginThrottle({ failures: 9, lockedUntil: 0, updatedAt: currentTime - LOGIN_FAILURE_WINDOW_MS - 1 }, currentTime),
    { failures: 0, lockedUntil: 0 },
  )
})

test('调用方身份取转发链首个地址', () => {
  assert.equal(getClientIdentity({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), '203.0.113.7')
  assert.equal(getClientIdentity({ 'x-real-ip': '198.51.100.9' }), '198.51.100.9')
  assert.equal(getClientIdentity({}), 'unknown')
})
