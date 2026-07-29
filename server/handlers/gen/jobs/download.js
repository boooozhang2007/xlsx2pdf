import { rejectMethod, requireSession } from '../../../auth.js'
import { getWorksheetJobDownload, reexportWorksheetJob } from '../../../genQueue.js'

const toAsciiFileName = (value) => String(value || 'worksheet-export.zip').replace(/[^A-Za-z0-9._-]+/g, '_') || 'worksheet-export.zip'

export default async function handler(req, res) {
  if (req.method !== 'GET') return rejectMethod(res, 'GET')
  if (!requireSession(req, res)) return

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
    const jobId = String(url.searchParams.get('id') || '').trim()
    const reexport = url.searchParams.has('reexport')
    if (!jobId) {
      res.statusCode = 400
      res.end(JSON.stringify({ ok: false, error: '缺少任务 id。' }))
      return
    }

    const { job, buffer, fileName: reexportFileName } = reexport
      ? await reexportWorksheetJob(jobId)
      : await getWorksheetJobDownload(jobId)
    const fileName = reexportFileName || job.exportFileName || `${job.fileName.replace(/\.[^.]+$/, '')}.zip`
    res.statusCode = 200
    res.setHeader('content-type', 'application/zip')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-disposition', `attachment; filename=${toAsciiFileName(fileName)}; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    res.setHeader('content-length', String(buffer.length))
    res.end(buffer)
  } catch (error) {
    console.error(error)
    res.statusCode = error.statusCode || 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: error.message || '下载失败。' }))
  }
}
