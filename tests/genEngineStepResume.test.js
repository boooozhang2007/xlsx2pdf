import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

const readBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const parseInputItems = (content) => {
  const match = String(content || '').match(/Input JSON array:\n([\s\S]*?)\nReturn JSON array only\./)
  return match ? JSON.parse(match[1]) : []
}

test('large LLM jobs checkpoint and resume across bounded steps', async (t) => {
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    requestCount += 1
    const payload = JSON.parse(await readBody(request))
    const items = parseInputItems(payload.messages?.at(-1)?.content)
    const result = items.map((item) => ({
      id: item.id,
      definition_en: 'a clear classroom meaning',
      definition_zh: '清晰的课堂释义',
      synonym: 'similar',
      antonym: 'opposite',
    }))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `<think>${JSON.stringify({ plan: 'prepare fields' })}</think>\n${JSON.stringify(result)}`,
        },
      }],
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_API_KEY = 'test-key'
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.VIVI_LLM_MODEL = 'test-model'
  process.env.VIVI_LLM_BATCH_SIZE = '20'
  process.env.VIVI_LLM_CONCURRENCY = '5'

  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const rows = Array.from({ length: 250 }, (_, index) => ({
    english: `term${index + 1}`,
    chinese: `词条${index + 1}`,
  }))
  let initialCache = null
  const cacheSizes = []
  const firstProgressByRound = []
  let result = null

  for (let round = 0; round < 3; round += 1) {
    let latestCache = initialCache
    let firstProgress = null
    try {
      result = await generateWorksheetArchive({
        rows,
        fileName: 'resume-test.xlsx',
        questionTypes: ['一_释义匹配'],
        generationMode: 'legacy_zip',
        llmEntryLimit: 100,
        initialCache,
        onProgress: async (progress) => {
          firstProgress ||= progress
        },
        onCacheCheckpoint: async (cache) => {
          latestCache = structuredClone(cache)
        },
      })
    } catch (error) {
      assert.equal(error.code, 'JOB_STEP_YIELDED')
    }
    initialCache = latestCache
    cacheSizes.push(Object.keys(initialCache?.lexical || {}).length)
    firstProgressByRound.push(firstProgress?.stageWordCompleted)
  }

  assert.deepEqual(cacheSizes, [100, 200, 250])
  assert.deepEqual(firstProgressByRound, [0, 100, 200])
  assert.equal(requestCount, 13)
  assert.ok(result?.buffer?.length > 0)
})

test('a zero-valid batch stops instead of expanding into a retry storm', async (t) => {
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    requestCount += 1
    const payload = JSON.parse(await readBody(request))
    const items = parseInputItems(payload.messages?.at(-1)?.content)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(items.map((item) => ({ id: item.id }))) } }],
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  const { generateWorksheetArchive } = await import('../server/genEngine.js')

  await assert.rejects(
    generateWorksheetArchive({
      rows: [
        { english: 'alpha', chinese: '阿尔法' },
        { english: 'beta', chinese: '贝塔' },
      ],
      fileName: 'invalid-batch.xlsx',
      questionTypes: ['一_释义匹配'],
      generationMode: 'legacy_zip',
      llmEntryLimit: 100,
      onCacheCheckpoint: async () => {},
    }),
    (error) => error?.code === 'LLM_BATCH_REJECTED' && error?.batchSize === 2,
  )
  assert.equal(requestCount, 1)
})

test('safe format variations are accepted by order and normalized', async (t) => {
  const server = http.createServer(async (request, response) => {
    const payload = JSON.parse(await readBody(request))
    const items = parseInputItems(payload.messages?.at(-1)?.content)
    const isMaterial = payload.messages?.[0]?.content?.includes('cloze_full_sentence')
    const result = items.map((item, index) => isMaterial
      ? {
          ID: `changed-${index}`,
          cloze_sentence: 'Choose [BLANK] for this sentence.',
          true_sentence: `${item.word} appears in this vocabulary exercise.`,
          false_sentence: `${item.word} is not part of this vocabulary exercise.`,
        }
      : {
          ID: `changed-${index}`,
          definition_en: item.word === 'to' ? 'used to mark an infinitive' : 'a clear classroom meaning',
          definition_zh: '清晰的课堂释义',
          synonym: 'similar',
          antonym: 'opposite',
        })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const words = ['to', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta']
  const result = await generateWorksheetArchive({
    rows: words.map((english) => ({ english, chinese: `${english}的含义` })),
    fileName: 'format-variants.xlsx',
    questionTypes: ['一_释义匹配', '二_选择题'],
    generationMode: 'legacy_zip',
    llmEntryLimit: 100,
    onCacheCheckpoint: async () => {},
  })

  assert.ok(result.buffer.length > 0)
})

test('hyphenated synonym answers match space-separated sentences', async (t) => {
  const server = http.createServer(async (request, response) => {
    const payload = JSON.parse(await readBody(request))
    const items = parseInputItems(payload.messages?.at(-1)?.content)
    const isSynonymMaterial = payload.messages?.[0]?.content?.includes('synonym_rewrite_full')
    const result = items.map((item) => isSynonymMaterial
      ? {
          id: item.id,
          synonym: 'well-known',
          synonym_original: `${item.word} is famous in our town.`,
          synonym_rewrite_full: 'This person is well known in our town.',
          synonym_rewrite_blank: '',
        }
      : {
          id: item.id,
          definition_en: 'known by many people',
          definition_zh: '被许多人熟知',
          synonym: 'well-known',
          antonym: 'unknown',
        })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const result = await generateWorksheetArchive({
    rows: ['famous', 'noted', 'popular', 'recognized'].map((english) => ({ english, chinese: '著名的' })),
    fileName: 'hyphenated-synonyms.xlsx',
    questionTypes: ['三_同义替换'],
    generationMode: 'legacy_zip',
    llmEntryLimit: 100,
    onCacheCheckpoint: async () => {},
  })

  assert.ok(result.buffer.length > 0)
})
