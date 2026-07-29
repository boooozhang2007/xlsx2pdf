import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getEnv } from './auth.js'

let r2Client = null

export const getR2Client = () => {
  if (r2Client) return r2Client
  r2Client = new S3Client({
    region: 'auto',
    endpoint: getEnv('R2_ENDPOINT'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: getEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY'),
    },
  })
  return r2Client
}

export const getShareTtlMs = () => {
  const days = Number(process.env.TTS_SHARE_TTL_DAYS || '3650')
  const safeDays = Number.isFinite(days) && days > 0 ? days : 3650
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

export const putObject = async ({ key, body, contentType = 'application/octet-stream', ifMatch, ifNoneMatch }) => getR2Client().send(
  new PutObjectCommand({
    Bucket: getEnv('R2_BUCKET'),
    Key: key,
    Body: body,
    ContentType: contentType,
    ...(ifMatch ? { IfMatch: ifMatch } : {}),
    ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
  }),
)

const readBodyToBuffer = async (body) => {
  if (!body) return Buffer.alloc(0)
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export const getObjectBuffer = async ({ key }) => {
  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: getEnv('R2_BUCKET'),
      Key: key,
    }),
  )
  return readBodyToBuffer(response.Body)
}

export const getObjectText = async ({ key }) => (await getObjectBuffer({ key })).toString('utf8')
export const getObjectJson = async ({ key }) => JSON.parse(await getObjectText({ key }))

export const getObjectJsonWithMetadata = async ({ key }) => {
  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: getEnv('R2_BUCKET'),
      Key: key,
    }),
  )
  return {
    value: JSON.parse((await readBodyToBuffer(response.Body)).toString('utf8')),
    etag: response.ETag || '',
  }
}

export const deleteObject = async ({ key }) => getR2Client().send(
  new DeleteObjectCommand({
    Bucket: getEnv('R2_BUCKET'),
    Key: key,
  }),
)

export const listObjects = async ({ prefix }) => {
  const items = []
  let continuationToken
  do {
    const response = await getR2Client().send(
      new ListObjectsV2Command({
        Bucket: getEnv('R2_BUCKET'),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    items.push(...(response.Contents || []))
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)
  return items
}
