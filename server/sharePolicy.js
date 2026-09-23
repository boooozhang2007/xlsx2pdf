// 分享读写的统一策略：路径形状、上传归属、体积与内容类型。读写两端共用，避免规则漂移。

export const SHARE_KEY_RE = /^tts-shares\/[0-9a-f-]{36}\/(?:manifest\.json|[a-z0-9._-]{1,96}\/[a-z0-9._-]{1,120}\.mp3)$/i

const SHARE_PREFIX_RE = /^tts-shares\/[0-9a-f-]{36}$/i

// 上传发生在创建分享后的几分钟内，12 小时足够覆盖长词表的逐段上传，同时限制泄露后的可用窗口。
export const UPLOAD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export const isSharePrefix = (value) => SHARE_PREFIX_RE.test(String(value || ''))

export const isManifestKey = (key) => SHARE_KEY_RE.test(String(key || '')) && /\/manifest\.json$/i.test(String(key || ''))

// 上传目标必须落在 upload token 绑定的前缀内，防止拿着自己的 token 覆盖他人的分享对象。
export const isKeyUnderPrefix = (key, prefix) => (
  isSharePrefix(prefix) && SHARE_KEY_RE.test(String(key || '')) && String(key).startsWith(`${prefix}/`)
)

export const normalizeContentType = (value) => String(value || '').split(';')[0].trim().toLowerCase()

export const isContentTypeAllowedForKey = (key, contentType) => {
  const normalized = normalizeContentType(contentType)
  return /\/manifest\.json$/i.test(String(key || ''))
    ? normalized === 'application/json'
    : normalized === 'audio/mpeg'
}

export const maxBytesForKey = (key) => (/\/manifest\.json$/i.test(String(key || '')) ? MAX_MANIFEST_BYTES : MAX_AUDIO_BYTES)
