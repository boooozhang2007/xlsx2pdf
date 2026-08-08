const textEncoder = new TextEncoder()
const ZIP_FLAG_UTF8 = 0x0800
const ZIP_EXTRA_FIELD_UNICODE_PATH = 0x7075

let crcTable = null

const getCrcTable = () => {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

const crc32 = (bytes) => {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const u16 = (value) => {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16LE(value & 0xffff, 0)
  return bytes
}

const u32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0, 0)
  return bytes
}

const getDosDateTime = (date = new Date()) => {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)
  return { dosTime, dosDate }
}

const normalizeBytes = (value) => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return Buffer.from(textEncoder.encode(String(value ?? '')))
}

const hasNonAsciiBytes = (bytes) => {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] > 0x7f) return true
  }
  return false
}

const createUnicodePathExtraField = (nameBytes) => {
  if (!hasNonAsciiBytes(nameBytes)) return Buffer.alloc(0)
  return Buffer.concat([
    u16(ZIP_EXTRA_FIELD_UNICODE_PATH),
    u16(5 + nameBytes.length),
    Buffer.from([1]),
    u32(crc32(nameBytes)),
    nameBytes,
  ])
}

export const createZipBuffer = (files) => {
  const localParts = []
  const centralParts = []
  let offset = 0

  files.forEach((file) => {
    const name = String(file.name || '').replace(/^\/+/, '')
    const nameBytes = Buffer.from(textEncoder.encode(name))
    const extraField = createUnicodePathExtraField(nameBytes)
    const dataBytes = normalizeBytes(file.data)
    const { dosTime, dosDate } = getDosDateTime(file.date)
    const checksum = crc32(dataBytes)

    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(ZIP_FLAG_UTF8),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(extraField.length),
      nameBytes,
      extraField,
    ])

    localParts.push(localHeader, dataBytes)

    const centralHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(ZIP_FLAG_UTF8),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(checksum),
      u32(dataBytes.length),
      u32(dataBytes.length),
      u16(nameBytes.length),
      u16(extraField.length),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
      extraField,
    ])

    centralParts.push(centralHeader)
    offset += localHeader.length + dataBytes.length
  })

  const centralDirectory = Buffer.concat(centralParts)
  const centralOffset = offset
  const endRecord = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(centralOffset),
    u16(0),
  ])

  return Buffer.concat([...localParts, centralDirectory, endRecord])
}

export const extractStoredZipFiles = (value) => {
  const buffer = normalizeBytes(value)
  const files = []
  let offset = 0

  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const fileNameLength = buffer.readUInt16LE(offset + 26)
    const extraFieldLength = buffer.readUInt16LE(offset + 28)
    if (compressionMethod !== 0) throw new Error('批量下载只支持本站生成的未压缩 ZIP。')

    const fileNameStart = offset + 30
    const dataStart = fileNameStart + fileNameLength + extraFieldLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error('ZIP 文件内容不完整。')

    const name = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString('utf8')
    if (name && !name.endsWith('/')) {
      files.push({ name, data: Buffer.from(buffer.subarray(dataStart, dataEnd)) })
    }
    offset = dataEnd
  }

  if (!files.length) throw new Error('ZIP 中没有可合并的文件。')
  return files
}
