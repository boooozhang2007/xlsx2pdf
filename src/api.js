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
