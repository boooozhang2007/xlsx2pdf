const DB_NAME = 'xlsx2pdf_tts_audio_library'
const DB_VERSION = 1
const SESSION_STORE = 'sessions'
const BLOB_STORE = 'blobs'

const ensureIndexedDb = () => {
  if (typeof indexedDB === 'undefined') {
    throw new Error('当前浏览器不支持本地音频库。')
  }
}

const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('本地音频库事务已取消。'))
  })

const openDb = () =>
  new Promise((resolve, reject) => {
    ensureIndexedDb()
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        const blobStore = db.createObjectStore(BLOB_STORE, { keyPath: 'key' })
        blobStore.createIndex('sessionId', 'sessionId', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const stripRuntimeAudio = (item) => ({
  id: item.id,
  words: item.words || [],
  label: item.label,
  title: item.title,
  subtitle: item.subtitle,
  provider: item.provider,
  pauseMs: item.pauseMs || 0,
  batchNo: item.batchNo,
  firstWord: item.firstWord,
  lastWord: item.lastWord,
  wordCount: item.wordCount,
  fileStem: item.fileStem,
  segments: item.segments?.map((segment) => ({
    word: segment.word,
    fileStem: segment.fileStem,
    contentType: segment.blob?.type || 'audio/mpeg',
  })),
})

const normalizeSessionForList = (session) => ({
  ...session,
  items: undefined,
  itemCount: session.items?.length || session.batchCount || 0,
})

export const listAudioSessions = async () => {
  const db = await openDb()
  const sessions = await requestToPromise(db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE).getAll())
  return sessions
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .map(normalizeSessionForList)
}

export const saveAudioSession = async (session, audioItems) => {
  const db = await openDb()
  const tx = db.transaction([SESSION_STORE, BLOB_STORE], 'readwrite')
  const sessionStore = tx.objectStore(SESSION_STORE)
  const blobStore = tx.objectStore(BLOB_STORE)
  const cleanSession = {
    ...session,
    updatedAt: Date.now(),
    items: audioItems.map(stripRuntimeAudio),
  }

  sessionStore.put(cleanSession)
  audioItems.forEach((item, itemIndex) => {
    if (item.segments?.length) {
      item.segments.forEach((segment, segmentIndex) => {
        if (!segment.blob) return
        blobStore.put({
          key: `${session.id}/${itemIndex}/${segmentIndex}`,
          sessionId: session.id,
          blob: segment.blob,
        })
      })
      return
    }
    if (item.blob) {
      blobStore.put({
        key: `${session.id}/${itemIndex}`,
        sessionId: session.id,
        blob: item.blob,
      })
    }
  })

  await transactionDone(tx)
  return normalizeSessionForList(cleanSession)
}

export const loadAudioSession = async (id) => {
  const db = await openDb()
  const session = await requestToPromise(db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE).get(id))
  if (!session) throw new Error('未找到这条本地生成记录。')

  const blobStore = db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE)
  const blobRecords = await requestToPromise(blobStore.index('sessionId').getAll(id))
  const blobMap = new Map(blobRecords.map((record) => [record.key, record.blob]))
  const items = (session.items || [])
    .map((item, itemIndex) => {
      if (item.segments?.length) {
        const segments = item.segments
          .map((segment, segmentIndex) => {
            const blob = blobMap.get(`${id}/${itemIndex}/${segmentIndex}`)
            if (!blob) return null
            return {
              ...segment,
              blob,
              url: URL.createObjectURL(blob),
            }
          })
          .filter(Boolean)
        return segments.length ? { ...item, segments } : null
      }

      const blob = blobMap.get(`${id}/${itemIndex}`)
      if (!blob) return null
      return {
        ...item,
        blob,
        url: URL.createObjectURL(blob),
      }
    })
    .filter(Boolean)

  if (!items.length) throw new Error('本地记录存在，但音频文件已丢失。')
  return { ...session, items }
}

export const updateAudioSessionShare = async (id, patch) => {
  const db = await openDb()
  const sessionStore = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE)
  const session = await requestToPromise(sessionStore.get(id))
  if (!session) return null

  const nextSession = { ...session, ...patch, updatedAt: Date.now() }
  const tx = db.transaction(SESSION_STORE, 'readwrite')
  tx.objectStore(SESSION_STORE).put(nextSession)
  await transactionDone(tx)
  return normalizeSessionForList(nextSession)
}

export const deleteAudioSession = async (id) => {
  const db = await openDb()
  const blobStore = db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE)
  const keys = await requestToPromise(blobStore.index('sessionId').getAllKeys(id))

  const tx = db.transaction([SESSION_STORE, BLOB_STORE], 'readwrite')
  tx.objectStore(SESSION_STORE).delete(id)
  const writableBlobStore = tx.objectStore(BLOB_STORE)
  keys.forEach((key) => writableBlobStore.delete(key))
  await transactionDone(tx)
}
