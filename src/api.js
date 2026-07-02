export const apiJson = async (url, options = {}) => {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `请求失败：${response.status}`)
    error.status = response.status
    error.detail = data.detail
    throw error
  }
  return data
}

export const fetchAudioBlob = async (url, payload) => {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok) {
    let message = `生成失败：${response.status}`
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => null)
      message = data?.error || message
    } else {
      message = (await response.text().catch(() => '')) || message
    }
    throw new Error(message)
  }
  return response.blob()
}

const parseContentDispositionName = (headerValue) => {
  if (!headerValue) return ''
  const utfMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1])
    } catch {
      // ignore malformed encoding and fall through
    }
  }
  const plainMatch = headerValue.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] || ''
}

export const fetchDownloadBlob = async (url, payload, onProgress) => {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const contentType = response.headers.get('content-type') || ''
  if (!response.ok) {
    let message = `生成失败：${response.status}`
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => null)
      message = data?.error || message
    } else {
      message = (await response.text().catch(() => '')) || message
    }
    throw new Error(message)
  }

  const totalBytes = Number.parseInt(response.headers.get('content-length') || '0', 10) || 0
  const fileName = parseContentDispositionName(response.headers.get('content-disposition') || '')
  const reader = response.body?.getReader()

  if (!reader) {
    const blob = await response.blob()
    onProgress?.({ receivedBytes: blob.size, totalBytes: blob.size || totalBytes })
    return { blob, fileName, totalBytes: blob.size || totalBytes }
  }

  const chunks = []
  let receivedBytes = 0
  onProgress?.({ receivedBytes, totalBytes })

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    receivedBytes += value.byteLength
    onProgress?.({ receivedBytes, totalBytes })
  }

  return {
    blob: new Blob(chunks, { type: contentType || 'application/octet-stream' }),
    fileName,
    totalBytes: receivedBytes || totalBytes,
  }
}
