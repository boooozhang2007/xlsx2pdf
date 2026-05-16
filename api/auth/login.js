import { comparePassword, createSessionCookie, readJsonBody, rejectMethod, sendJson } from '../../server/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  try {
    const { password } = await readJsonBody(req)
    if (!comparePassword(password || '')) {
      return sendJson(res, 401, { ok: false, error: '访问密码不正确。' })
    }
    res.setHeader('set-cookie', createSessionCookie())
    return sendJson(res, 200, { ok: true })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '登录失败。' })
  }
}

