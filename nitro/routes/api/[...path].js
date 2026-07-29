import authHandler from '../../../server/handlers/auth/index.js'
import genExportHandler from '../../../server/handlers/gen/export.js'
import genJobsHandler from '../../../server/handlers/gen/jobs.js'
import genDownloadHandler from '../../../server/handlers/gen/jobs/download.js'
import genRecoverHandler from '../../../server/handlers/gen/jobs/recover.js'
import shareHandler from '../../../server/handlers/share/index.js'
import shareStartHandler from '../../../server/handlers/share/start.js'
import shareUploadHandler from '../../../server/handlers/share/upload.js'
import shareFinalizeHandler from '../../../server/handlers/share/finalize.js'
import azureHandler from '../../../server/handlers/tts/azure.js'
import edgeHandler from '../../../server/handlers/tts/edge.js'
import voicesHandler from '../../../server/handlers/tts/voices.js'
import { runNodeHandler } from '../../../server/nitroAdapter.js'

const handlers = new Map([
  ['/api/auth', authHandler],
  ['/api/gen/export', genExportHandler],
  ['/api/gen/jobs', genJobsHandler],
  ['/api/gen/jobs/download', genDownloadHandler],
  ['/api/gen/jobs/recover', genRecoverHandler],
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
