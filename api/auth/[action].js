import {
  clearSessionCookie,
  comparePassword,
  createSessionCookie,
  readJsonBody,
  rejectMethod,
  sendJson,
  verifySession,
} from '../../server/auth.js'

const getAction = (req) => {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
  const parts = url.pathname.replace(/\/+$/g, '').split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

const handleLogin = async (req, res) => {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  const { password } = await readJsonBody(req)
  if (!comparePassword(password || '')) {
    return sendJson(res, 401, { ok: false, error: '访问密码不正确。' })
  }
  res.setHeader('set-cookie', createSessionCookie())
  return sendJson(res, 200, { ok: true })
}

const handleLogout = async (req, res) => {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  res.setHeader('set-cookie', clearSessionCookie())
  return sendJson(res, 200, { ok: true })
}

const handleMe = async (req, res) => {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')
  return sendJson(res, 200, { ok: true, authenticated: verifySession(req) })
}

export default async function handler(req, res) {
  try {
    const action = getAction(req)
    if (action === 'login') return handleLogin(req, res)
    if (action === 'logout') return handleLogout(req, res)
    if (action === 'me') return handleMe(req, res)
    return sendJson(res, 404, { ok: false, error: '未找到认证接口。' })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || '认证请求失败。',
    })
  }
}
