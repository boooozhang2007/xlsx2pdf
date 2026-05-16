import crypto from 'node:crypto'
import { createShareToken, readJsonBody, rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { getShareTtlMs } from '../../server/r2.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const count = Math.min(100, Math.max(1, Number.parseInt(body.count, 10) || 1))
    const shareId = crypto.randomUUID()
    const prefix = `tts-shares/${shareId}`
    const expiresAt = Date.now() + getShareTtlMs()
    const manifestKey = `${prefix}/manifest.json`

    const audio = []
    for (let index = 0; index < count; index += 1) {
      const key = `${prefix}/audio-${String(index + 1).padStart(3, '0')}.mp3`
      audio.push({ key })
    }

    return sendJson(res, 200, {
      ok: true,
      shareId,
      expiresAt,
      token: createShareToken({ key: manifestKey, expiresAt }),
      manifest: { key: manifestKey },
      audio,
    })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '创建分享失败。' })
  }
}

