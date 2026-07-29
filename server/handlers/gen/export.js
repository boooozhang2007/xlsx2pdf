import { readJsonBody, rejectMethod, requireSession, sendJson } from '../../auth.js'
import { generateWorksheetArchive } from '../../genEngine.js'

const MAX_CHUNK_SIZE = 64 * 1024

const toAsciiFileName = (value) => String(value || 'worksheet-export.zip').replace(/[^A-Za-z0-9._-]+/g, '_') || 'worksheet-export.zip'

export default async function handler(req, res) {
  if (req.method !== 'POST') return rejectMethod(res, 'POST')
  if (!requireSession(req, res)) return

  try {
    const body = await readJsonBody(req)
    const rows = Array.isArray(body.rows) ? body.rows : null
    const questionTypes = Array.isArray(body.questionTypes) ? body.questionTypes : undefined
    if (!rows) {
      return sendJson(res, 400, { ok: false, error: 'rows 必须是数组。' })
    }

    const result = await generateWorksheetArchive({
      rows,
      fileName: body.fileName || body.title || '词组练习.xlsx',
      questionTypes,
    })

    const encodedName = encodeURIComponent(result.fileName)
    res.statusCode = 200
    res.setHeader('content-type', 'application/zip')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-disposition', `attachment; filename=${toAsciiFileName(result.fileName)}; filename*=UTF-8''${encodedName}`)
    res.setHeader('content-length', String(result.buffer.length))
    res.setHeader('x-export-words', String(result.wordCount))
    res.setHeader('x-export-types', result.questionTypeKeys.join(','))

    for (let offset = 0; offset < result.buffer.length; offset += MAX_CHUNK_SIZE) {
      res.write(result.buffer.subarray(offset, offset + MAX_CHUNK_SIZE))
    }
    res.end()
  } catch (error) {
    console.error(error)
    return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || '生成失败。' })
  }
}
