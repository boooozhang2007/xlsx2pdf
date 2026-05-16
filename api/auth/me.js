import { rejectMethod, sendJson, verifySession } from '../../server/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')
  try {
    return sendJson(res, 200, { ok: true, authenticated: verifySession(req) })
  } catch (error) {
    console.error(error)
    return sendJson(res, 200, { ok: true, authenticated: false, error: error.message })
  }
}

