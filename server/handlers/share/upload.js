import { readJsonBody, rejectMethod, requireSession, sendJson, verifyShareToken } from '../../auth.js'
import { putObject } from '../../r2.js'
import { isContentTypeAllowedForKey, isKeyUnderPrefix, maxBytesForKey } from '../../sharePolicy.js'

const formatMb = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const key = String(body.key || '')
    const contentType = String(body.contentType || 'application/octet-stream')

    const grant = verifyShareToken(String(body.uploadToken || ''), { purpose: 'upload' })
    if (!grant) {
      return sendJson(res, 403, { ok: false, error: '上传凭证无效或已过期，请重新生成分享。' })
    }
    if (!isKeyUnderPrefix(key, grant.key)) {
      return sendJson(res, 403, { ok: false, error: '上传目标不属于本次分享。' })
    }

    if (!isContentTypeAllowedForKey(key, contentType)) {
      return sendJson(res, 400, { ok: false, error: '上传内容类型与目标文件不匹配。' })
    }

    let objectBody
    if (typeof body.base64 === 'string') {
      objectBody = Buffer.from(body.base64, 'base64')
    } else if (typeof body.text === 'string') {
      objectBody = Buffer.from(body.text, 'utf8')
    } else {
      return sendJson(res, 400, { ok: false, error: '缺少上传内容。' })
    }

    const maxBytes = maxBytesForKey(key)
    if (objectBody.byteLength > maxBytes) {
      return sendJson(res, 413, { ok: false, error: `单个文件不能超过 ${formatMb(maxBytes)}。` })
    }

    await putObject({ key, body: objectBody, contentType })
    return sendJson(res, 200, { ok: true, key })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '上传到 R2 失败。' })
  }
}
