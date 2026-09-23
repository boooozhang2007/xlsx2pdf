// 供 handler 级测试使用的极简 Node IncomingMessage / ServerResponse 替身。
// 只实现本项目 handler 实际用到的成员（method / url / headers / body 与
// statusCode / setHeader / end），不做流式与背压。handler 返回即代表响应已写完。

export const createFakeRequest = ({ method = 'GET', url = '/', cookie = '', body, headers = {} } = {}) => ({
  method,
  url,
  headers: { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers },
  ...(body === undefined ? {} : { body }),
})

export const createFakeResponse = () => {
  const headers = new Map()
  const chunks = []
  return {
    statusCode: 200,
    headers,
    setHeader: (key, value) => headers.set(String(key).toLowerCase(), value),
    getHeader: (key) => headers.get(String(key).toLowerCase()),
    write: (chunk) => { chunks.push(Buffer.from(chunk)) },
    end: (chunk) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk))
    },
    rawBody: () => Buffer.concat(chunks).toString('utf8'),
  }
}

export const readJsonResponse = (res) => ({
  status: res.statusCode,
  headers: res.headers,
  payload: JSON.parse(res.rawBody() || '{}'),
})
