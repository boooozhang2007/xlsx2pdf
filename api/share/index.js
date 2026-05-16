import { rejectMethod, sendJson, verifyShareToken } from '../../server/auth.js'
import { createGetUrl } from '../../server/r2.js'

export default async function handler(req, res) {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
    const token = url.searchParams.get('token')
    const data = verifyShareToken(token)
    if (!data) return sendJson(res, 401, { ok: false, error: '播放链接无效或已过期。' })

    const manifestUrl = await createGetUrl({ key: data.key, expiresIn: 60 * 10 })
    const manifestResponse = await fetch(manifestUrl)
    if (!manifestResponse.ok) {
      return sendJson(res, 404, { ok: false, error: '未找到播放清单。' })
    }
    const manifest = await manifestResponse.json()
    const tracks = await Promise.all(
      (manifest.tracks || []).map(async (track) => ({
        ...track,
        url: await createGetUrl({ key: track.key, expiresIn: 60 * 60 }),
      })),
    )

    return sendJson(res, 200, { ok: true, manifest: { ...manifest, tracks }, expiresAt: data.expiresAt })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '读取分享失败。' })
  }
}

