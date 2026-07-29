import authHandler from '../../../api/auth/index.js'
import genExportHandler from '../../../api/gen/export.js'
import genJobsHandler from '../../../api/gen/jobs.js'
import genDownloadHandler from '../../../api/gen/jobs/download.js'
import shareHandler from '../../../api/share/index.js'
import shareStartHandler from '../../../api/share/start.js'
import shareUploadHandler from '../../../api/share/upload.js'
import shareFinalizeHandler from '../../../api/share/finalize.js'
import azureHandler from '../../../api/tts/azure.js'
import edgeHandler from '../../../api/tts/edge.js'
import voicesHandler from '../../../api/tts/voices.js'
import { runNodeHandler } from '../../../server/nitroAdapter.js'

const handlers = new Map([
  ['/api/auth', authHandler],
  ['/api/gen/export', genExportHandler],
  ['/api/gen/jobs', genJobsHandler],
  ['/api/gen/jobs/download', genDownloadHandler],
  ['/api/share', shareHandler],
  ['/api/share/start', shareStartHandler],
  ['/api/share/upload', shareUploadHandler],
  ['/api/share/finalize', shareFinalizeHandler],
  ['/api/tts/azure', azureHandler],
  ['/api/tts/edge', edgeHandler],
  ['/api/tts/voices', voicesHandler],
])

export default async ({ req }) => {
  const pathname = new URL(req.url).pathname.replace(/\/$/, '') || '/'
  const handler = handlers.get(pathname)
  if (!handler) return Response.json({ ok: false, error: '未找到对应接口。' }, { status: 404 })
  return runNodeHandler(handler, req)
}
