import { rejectMethod, sendJson, verifyShareToken } from '../../auth.js'
import { createGetUrl } from '../../r2.js'
import { SHARE_KEY_RE, isManifestKey } from '../../sharePolicy.js'

// manifest 里的 track.key 来自对象存储，必须按前缀白名单校验后再签发预签名 URL，
// 否则被篡改的清单可以让服务端为桶内任意对象签发可读链接。
const resolveSharePrefix = (manifestKey) => String(manifestKey || '').replace(/\/manifest\.json$/i, '')

const isTracksKeyAllowed = (key, prefix) => (
  SHARE_KEY_RE.test(String(key || ''))
  && String(key).startsWith(`${prefix}/`)
  && !/\/manifest\.json$/i.test(String(key))
)

export default async function handler(req, res) {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
    const token = url.searchParams.get('token')
    const data = verifyShareToken(token, { purpose: 'listen', allowLegacy: true })
    if (!data) return sendJson(res, 401, { ok: false, error: '播放链接无效或已过期。' })
    if (!isManifestKey(data.key)) return sendJson(res, 401, { ok: false, error: '播放链接无效或已过期。' })

    const prefix = resolveSharePrefix(data.key)
    const manifestUrl = await createGetUrl({ key: data.key, expiresIn: 60 * 10 })
    const manifestResponse = await fetch(manifestUrl)
    if (!manifestResponse.ok) {
      return sendJson(res, 404, { ok: false, error: '未找到播放清单。' })
    }
    const manifest = await manifestResponse.json()
    const tracks = (manifest.tracks || []).filter((track) => isTracksKeyAllowed(track?.key, prefix))
    const signedTracks = await Promise.all(
      tracks.map(async (track) => ({
        ...track,
        url: await createGetUrl({ key: track.key, expiresIn: 60 * 60 }),
      })),
    )

    return sendJson(res, 200, { ok: true, manifest: { ...manifest, tracks: signedTracks }, expiresAt: data.expiresAt })
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '读取分享失败。' })
  }
}
