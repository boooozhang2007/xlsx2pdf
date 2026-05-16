import crypto from 'node:crypto'

const SESSION_COOKIE = 'tts_session'
const SESSION_MAX_AGE = 60 * 60 * 12
const cookieSecureFlag = process.env.VERCEL_ENV ? '; Secure' : ''

const timingSafeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('请求体不是有效 JSON')
    error.statusCode = 400
    throw error
  }
}

export const sendJson = (res, status, payload, headers = {}) => {
  res.statusCode = status
  Object.entries({ 'content-type': 'application/json; charset=utf-8', ...headers }).forEach(([key, value]) => {
    res.setHeader(key, value)
  })
  res.end(JSON.stringify(payload))
}

export const rejectMethod = (res, allow = 'GET, POST') => {
  res.setHeader('allow', allow)
  sendJson(res, 405, { ok: false, error: 'Method not allowed' })
}

export const getEnv = (name, required = true) => {
  const value = process.env[name]
  if (required && !value) {
    const error = new Error(`缺少环境变量 ${name}`)
    error.statusCode = 500
    throw error
  }
  return value || ''
}

const parseCookieHeader = (cookieHeader = '') => Object.fromEntries(
  cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      if (index === -1) return [part, '']
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
    }),
)

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url')

export const createSessionCookie = () => {
  const secret = getEnv('TTS_SESSION_SECRET')
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000
  const nonce = crypto.randomBytes(16).toString('base64url')
  const payload = `${expiresAt}.${nonce}`
  const value = `${payload}.${sign(payload, secret)}`
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${cookieSecureFlag}`
}

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookieSecureFlag}`

export const verifySession = (req) => {
  const secret = getEnv('TTS_SESSION_SECRET')
  const cookies = parseCookieHeader(req.headers.cookie || '')
  const value = cookies[SESSION_COOKIE]
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [expiresAtText, nonce, signature] = parts
  const payload = `${expiresAtText}.${nonce}`
  const expected = sign(payload, secret)
  const expiresAt = Number(expiresAtText)
  return Number.isFinite(expiresAt) && expiresAt > Date.now() && timingSafeEqual(signature, expected)
}

export const requireSession = (req, res) => {
  if (verifySession(req)) return true
  sendJson(res, 401, { ok: false, error: '请先输入访问密码。' })
  return false
}

export const comparePassword = (password) => timingSafeEqual(password, getEnv('TTS_ACCESS_PASSWORD'))

export const signShare = (payload) => sign(payload, getEnv('SHARE_SIGNING_SECRET'))

export const createShareToken = ({ key, expiresAt }) => {
  const payload = Buffer.from(JSON.stringify({ key, expiresAt }), 'utf8').toString('base64url')
  return `${payload}.${signShare(payload)}`
}

export const verifyShareToken = (token) => {
  if (!token || typeof token !== 'string') return null
  const index = token.lastIndexOf('.')
  if (index === -1) return null
  const payload = token.slice(0, index)
  const signature = token.slice(index + 1)
  if (!timingSafeEqual(signature, signShare(payload))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.key || !data?.expiresAt || Number(data.expiresAt) < Date.now()) return null
    return data
  } catch {
    return null
  }
}
