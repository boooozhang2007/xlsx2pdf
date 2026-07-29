import crypto from 'node:crypto'
import { createShareToken, readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import { getShareTtlMs } from '../../r2.js'

const sanitizeName = (value, fallback) => {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || fallback
}

const pad3 = (value) => String(Math.max(1, Number.parseInt(value, 10) || 1)).padStart(3, '0')

const buildBatchLabel = ({ batchNo, firstWord, lastWord, wordCount }) => {
  const first = sanitizeName(firstWord, 'word')
  const last = sanitizeName(lastWord, first)
  const count = `${Math.max(1, Number.parseInt(wordCount, 10) || 1)}w`
  if (first === last) return `${pad3(batchNo)}_${first}_${count}`
  return `${pad3(batchNo)}_${first}-to-${last}_${count}`
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
      const batchLabel = buildBatchLabel({
        batchNo,
        firstWord: file.batchFirstWord || file.word,
        lastWord: file.batchLastWord || file.word,
        wordCount: file.batchWordCount || 1,
      })
      const folder = `${prefix}/${batchLabel}`
      const fileName = file.segmented
        ? `${pad3(segmentNo)}_${sanitizeName(file.word, 'word')}.mp3`
        : `${batchLabel}.mp3`
      const key = `${folder}/${fileName}`
      audio.push({ key, folder, fileName, batchLabel })
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
