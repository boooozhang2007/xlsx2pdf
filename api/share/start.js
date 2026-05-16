import crypto from 'node:crypto'
import { createShareToken, readJsonBody, rejectMethod, requireSession, sendJson } from '../../server/auth.js'
import { getShareTtlMs } from '../../server/r2.js'

const sanitizeName = (value, fallback) => {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || fallback
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const count = Math.min(1000, Math.max(1, Number.parseInt(body.count, 10) || 1))
    const files = Array.isArray(body.files) ? body.files.slice(0, count) : []
    const shareId = crypto.randomUUID()
    const prefix = `tts-shares/${shareId}`
    const expiresAt = Date.now() + getShareTtlMs()
    const manifestKey = `${prefix}/manifest.json`

    const audio = []
    for (let index = 0; index < count; index += 1) {
      const file = files[index] || {}
      const batchNo = Math.max(1, Number.parseInt(file.sourceIndex, 10) + 1 || index + 1)
      const segmentNo = Math.max(1, Number.parseInt(file.segmentIndex, 10) + 1 || 1)
      const batchFolder = `batch-${String(batchNo).padStart(3, '0')}`
      const fileName = file.segmented
        ? `word-${String(segmentNo).padStart(4, '0')}-${sanitizeName(file.word, 'word')}.mp3`
        : `batch-${String(batchNo).padStart(3, '0')}.mp3`
      const key = `${prefix}/${batchFolder}/${fileName}`
      audio.push({ key, folder: `${prefix}/${batchFolder}`, fileName })
    }

    return sendJson(res, 200, {
      ok: true,
      shareId,
      prefix,
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

