import { readJsonBody, rejectMethod, requireSession } from '../../../auth.js'
import { getWorksheetJobDownload, reexportWorksheetJob } from '../../../genQueue.js'
import { getBatchDownloadFileName, getWorksheetDownloadFileName } from '../../../downloadNaming.js'
import { createZipBuffer, extractStoredZipFiles } from '../../../zip.js'

const toAsciiFileName = (value) => String(value || 'worksheet-export.zip').replace(/[^A-Za-z0-9._-]+/g, '_') || 'worksheet-export.zip'

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method || '')) return rejectMethod(res, 'GET, POST')
  if (!requireSession(req, res)) return

  try {
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const jobIds = [...new Set((Array.isArray(body.ids) ? body.ids : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))]
      if (!jobIds.length || jobIds.length > 20) {
        const error = new Error('请选择 1–20 个已完成任务进行批量下载。')
        error.statusCode = 400
        throw error
      }

      const downloads = []
      for (const jobId of jobIds) downloads.push(await getWorksheetJobDownload(jobId))
      const mergedFiles = []
      const usedNames = new Set()
      downloads.forEach(({ buffer }, jobIndex) => {
        extractStoredZipFiles(buffer).forEach((file, fileIndex) => {
          const baseName = String(file.name || '').split('/').filter(Boolean).pop() || `文件${fileIndex + 1}`
          const prefix = String(jobIndex + 1).padStart(2, '0')
          let mergedName = `${prefix}_${baseName}`
          let duplicateIndex = 2
          while (usedNames.has(mergedName)) {
            const dotIndex = baseName.lastIndexOf('.')
            const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName
            const extension = dotIndex > 0 ? baseName.slice(dotIndex) : ''
            mergedName = `${prefix}_${stem}_${duplicateIndex}${extension}`
            duplicateIndex += 1
          }
          usedNames.add(mergedName)
          mergedFiles.push({ name: mergedName, data: file.data })
        })
      })

      const fileName = getBatchDownloadFileName(downloads.map((item) => item.job))
      const buffer = createZipBuffer(mergedFiles)
      res.statusCode = 200
      res.setHeader('content-type', 'application/zip')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-disposition', `attachment; filename=${toAsciiFileName(fileName)}; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      res.setHeader('content-length', String(buffer.length))
      res.end(buffer)
      return
    }

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
    const fileName = getWorksheetDownloadFileName(job, reexportFileName)
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
