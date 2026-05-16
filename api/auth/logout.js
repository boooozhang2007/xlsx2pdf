import { clearSessionCookie, rejectMethod, sendJson } from '../../server/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  res.setHeader('set-cookie', clearSessionCookie())
  return sendJson(res, 200, { ok: true })
}

