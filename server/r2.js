import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getEnv } from './auth.js'

export const getR2Client = () => new S3Client({
  region: 'auto',
  endpoint: getEnv('R2_ENDPOINT'),
  forcePathStyle: true,
  credentials: {
    accessKeyId: getEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY'),
  },
})

export const getShareTtlMs = () => {
  const days = Number(process.env.TTS_SHARE_TTL_DAYS || '7')
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7
  return safeDays * 24 * 60 * 60 * 1000
}

export const createPutUrl = async ({ key, contentType = 'application/json' }) => getSignedUrl(
  getR2Client(),
  new PutObjectCommand({
    Bucket: getEnv('R2_BUCKET'),
    Key: key,
    ContentType: contentType,
  }),
  { expiresIn: 60 * 15 },
)

export const createGetUrl = async ({ key, expiresIn = 60 * 60 * 24 }) => getSignedUrl(
  getR2Client(),
  new GetObjectCommand({
    Bucket: getEnv('R2_BUCKET'),
    Key: key,
  }),
  { expiresIn },
)

export const putObject = async ({ key, body, contentType = 'application/octet-stream' }) => getR2Client().send(
  new PutObjectCommand({
    Bucket: getEnv('R2_BUCKET'),
    Key: key,
    Body: body,
    ContentType: contentType,
  }),
)
