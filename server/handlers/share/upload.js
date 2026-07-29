import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import { putObject } from '../../r2.js'

const SHARE_KEY_RE = /^tts-shares\/[0-9a-f-]{36}\/(?:manifest\.json|[a-z0-9._-]{1,96}\/[a-z0-9._-]{1,120}\.mp3)$/i

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const key = String(body.key || '')
    const contentType = String(body.contentType || 'application/octet-stream')

    if (!SHARE_KEY_RE.test(key)) {
      return sendJson(res, 400, { ok: false, error: '分享对象路径无效。' })
    }

    let objectBody
    if (typeof body.base64 === 'string') {
      objectBody = Buffer.from(body.base64, 'base64')
    } else if (typeof body.text === 'string') {
      objectBody = Buffer.from(body.text, 'utf8')
    } else {
      return sendJson(res, 400, { ok: false, error: '缺少上传内容。' })
    }

    await putObject({ key, body: objectBody, contentType })
    return sendJson(res, 200, { ok: true, key })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '上传到 R2 失败。' })
  }
}
