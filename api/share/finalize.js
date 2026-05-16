import { rejectMethod, requireSession, sendJson } from '../../server/auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return
  return sendJson(res, 200, { ok: true, message: '分享已生成。' })
}

