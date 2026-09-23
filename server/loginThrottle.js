import crypto from 'node:crypto'
import { deleteObject, getObjectJson, putObject } from './r2.js'

// 登录失败限流：以调用方身份为键，计数写在 R2 上，跨 Serverless 实例生效。
// 任何存储故障都必须放行——限流是防御措施，不该成为把自己锁在门外的原因。

const THROTTLE_PREFIX = 'auth-throttle'
export const LOGIN_FAILURE_THRESHOLD = 5
export const LOGIN_LOCK_BASE_MS = 30 * 1000
export const LOGIN_LOCK_MAX_MS = 15 * 60 * 1000
// 超过这个空闲时长就不再累计历史失败次数，避免几天前的偶发失败持续抬高惩罚。
export const LOGIN_FAILURE_WINDOW_MS = 60 * 60 * 1000

const now = () => Date.now()
const throttleKey = (identity) => `${THROTTLE_PREFIX}/${crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 32)}.json`

export const getClientIdentity = (headers = {}) => {
  const forwarded = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')
  const first = forwarded.split(',')[0].trim()
  return first || 'unknown'
}

export const computeLoginLockMs = (failures) => {
  const over = Number(failures) - LOGIN_FAILURE_THRESHOLD
  if (!Number.isFinite(over) || over < 0) return 0
  return Math.min(LOGIN_LOCK_MAX_MS, LOGIN_LOCK_BASE_MS * 2 ** Math.min(over, 10))
}

export const describeLoginThrottle = (record, currentTime = now()) => {
  const failures = Math.max(0, Number(record?.failures || 0))
  const lastFailureAt = Number(record?.updatedAt || 0)
  if (lastFailureAt && currentTime - lastFailureAt > LOGIN_FAILURE_WINDOW_MS) {
    return { failures: 0, lockedUntil: 0 }
  }
  const lockedUntil = Number(record?.lockedUntil || 0)
  return { failures, lockedUntil: lockedUntil > currentTime ? lockedUntil : 0 }
}

const readRecord = async (identity) => getObjectJson({ key: throttleKey(identity) }).catch(() => null)

export const checkLoginAllowed = async (headers) => {
  try {
    const state = describeLoginThrottle(await readRecord(getClientIdentity(headers)))
    if (!state.lockedUntil) return { allowed: true, retryAfterSeconds: 0 }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntil - now()) / 1000)) }
  } catch (error) {
    console.warn('登录限流检查失败，已放行：', error?.message || error)
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export const recordLoginFailure = async (headers) => {
  try {
    const identity = getClientIdentity(headers)
    const state = describeLoginThrottle(await readRecord(identity))
    const failures = state.failures + 1
    const lockMs = computeLoginLockMs(failures)
    await putObject({
      key: throttleKey(identity),
      body: Buffer.from(JSON.stringify({
        failures,
        lockedUntil: lockMs ? now() + lockMs : 0,
        updatedAt: now(),
      })),
      contentType: 'application/json; charset=utf-8',
    })
  } catch (error) {
    console.warn('登录失败计数写入失败：', error?.message || error)
  }
}

export const clearLoginFailures = async (headers) => {
  try {
    await deleteObject({ key: throttleKey(getClientIdentity(headers)) })
  } catch (error) {
    console.warn('登录失败计数清理失败：', error?.message || error)
  }
}
