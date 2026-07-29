import { Readable } from 'node:stream'

const toNodeHeaders = (headers) => {
  const result = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

const toBuffer = (value) => {
  if (value == null) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value))
}

export const runNodeHandler = async (handler, request) => {
  const url = new URL(request.url)
  const requestBody = ['GET', 'HEAD'].includes(request.method)
    ? Buffer.alloc(0)
    : Buffer.from(await request.arrayBuffer())
  const req = Readable.from(requestBody.length ? [requestBody] : [])
  req.method = request.method
  req.url = `${url.pathname}${url.search}`
  req.headers = toNodeHeaders(request.headers)
  req.headers.host ||= url.host

  if ((req.headers['content-type'] || '').includes('application/json') && requestBody.length) {
    try {
      req.body = JSON.parse(requestBody.toString('utf8'))
    } catch {
      // Let the existing handler return its normal invalid JSON response.
    }
  }

  const responseHeaders = new Map()
  const chunks = []
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      responseHeaders.set(String(name).toLowerCase(), value)
      return this
    },
    getHeader(name) {
      return responseHeaders.get(String(name).toLowerCase())
    },
    removeHeader(name) {
      responseHeaders.delete(String(name).toLowerCase())
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value))
      this.headersSent = true
      return this
    },
    write(value) {
      const chunk = toBuffer(value)
      if (chunk) chunks.push(chunk)
      this.headersSent = true
      return true
    },
    end(value) {
      const chunk = toBuffer(value)
      if (chunk) chunks.push(chunk)
      this.headersSent = true
      return this
    },
  }

  await handler(req, res)

  const headers = new Headers()
  responseHeaders.forEach((value, name) => {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, String(item)))
    else if (value != null) headers.set(name, String(value))
  })
  const body = chunks.length ? Buffer.concat(chunks) : null
  return new Response(body, { status: res.statusCode, headers })
}
