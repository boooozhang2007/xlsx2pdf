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

const findStoredZipEntry = (buffer, predicate) => {
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 8)
    const dataSize = buffer.readUInt32LE(offset + 18)
    const nameSize = buffer.readUInt16LE(offset + 26)
    const extraSize = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameSize + extraSize
    const name = buffer.subarray(nameStart, nameStart + nameSize).toString('utf8')
    if (predicate(name)) {
      assert.equal(compressionMethod, 0, `test ZIP parser only supports stored entries: ${name}`)
      return buffer.subarray(dataStart, dataStart + dataSize)
    }
    offset = dataStart + dataSize
  }
  return null
}

const buildFixedTestPaperFixture = (count = 30) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    english: `sampleword${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
    chinese: `示例词义${index + 1}`,
  }))
  const initialCache = { lexical: {}, basic: {}, synonym: {} }
  rows.forEach(({ english, chinese }, index) => {
    const key = `${english}||${chinese}`
    initialCache.lexical[key] = {
      definitionEn: `definition for item ${index + 1}`,
      definitionZh: `第一题译文${index + 1}`,
      synonym: `similar${index + 1}`,
      antonym: `opposite${index + 1}`,
    }
    initialCache.basic[key] = {
      clozeSentence: `This sentence uses ______ for item ${index + 1}.`,
      tfTrue: `The true statement for item ${index + 1}.`,
      tfFalse: `The false statement for item ${index + 1}.`,
    }
    initialCache.synonym[key] = {
      synonym: `similar${index + 1}`,
      synonymOriginal: `The original sentence contains ${english}.`,
      synonymRewriteBlank: 'The rewritten sentence contains ______.',
    }
  })
  return { rows, initialCache }
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

test('a transient request failure exits the step without splitting batches', async (t) => {
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    requestCount += 1
    await readBody(request)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'temporary upstream failure' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.VIVI_LLM_REQUEST_RETRIES = '1'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')

  await assert.rejects(
    generateWorksheetArchive({
      rows: [
        { english: 'alpha', chinese: '阿尔法' },
        { english: 'beta', chinese: '贝塔' },
      ],
      fileName: 'request-failure.xlsx',
      questionTypes: ['一_释义匹配'],
      generationMode: 'legacy_zip',
      llmEntryLimit: 100,
      onCacheCheckpoint: async () => {},
    }),
    (error) => error?.code === 'LLM_REQUEST_FAILED' && error?.retryable === true,
  )
  assert.equal(requestCount, 1)
})

test('rate limits exit the step without cycling through fallback models', async (t) => {
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    requestCount += 1
    await readBody(request)
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
    response.end(JSON.stringify({ error: 'rate limited' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.VIVI_LLM_MODEL = 'test-model'
  process.env.VIVI_LLM_MODELS = JSON.stringify([
    { id: 'test-model', label: 'Primary' },
    { id: 'fallback-one', label: 'Fallback one' },
    { id: 'fallback-two', label: 'Fallback two' },
  ])
  const { generateWorksheetArchive } = await import('../server/genEngine.js')

  await assert.rejects(
    generateWorksheetArchive({
      rows: [
        { english: 'alpha', chinese: '阿尔法' },
        { english: 'beta', chinese: '贝塔' },
      ],
      fileName: 'rate-limit.xlsx',
      questionTypes: ['一_释义匹配'],
      generationMode: 'legacy_zip',
      llmModel: 'test-model',
      llmEntryLimit: 100,
      onCacheCheckpoint: async () => {},
    }),
    (error) => error?.code === 'LLM_RATE_LIMITED',
  )
  assert.equal(requestCount, 1)
})

test('intermittent access rejection is retryable across workflow steps', async (t) => {
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    requestCount += 1
    await readBody(request)
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'temporary access rejection' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.VIVI_LLM_MODEL = 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')

  await assert.rejects(
    generateWorksheetArchive({
      rows: [{ english: 'alpha', chinese: '阿尔法' }],
      fileName: 'access-rejection.xlsx',
      questionTypes: ['一_释义匹配'],
      generationMode: 'legacy_zip',
      llmModel: 'test-model',
      llmEntryLimit: 100,
      onCacheCheckpoint: async () => {},
    }),
    (error) => error?.code === 'LLM_REQUEST_FAILED' && error?.status === 401 && error?.retryable === true,
  )
  assert.equal(requestCount, 1)
})

test('gateway 400 responses are retryable and preserve their error detail', async (t) => {
  const server = http.createServer(async (request, response) => {
    await readBody(request)
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'temporary model gateway rejection' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const address = server.address()
  process.env.VIVI_LLM_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.VIVI_LLM_MODEL = 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')

  await assert.rejects(
    generateWorksheetArchive({
      rows: [{ english: 'alpha', chinese: '阿尔法' }],
      fileName: 'bad-gateway-request.xlsx',
      questionTypes: ['一_释义匹配'],
      generationMode: 'legacy_zip',
      llmModel: 'test-model',
      llmEntryLimit: 100,
      onCacheCheckpoint: async () => {},
    }),
    (error) => (
      error?.code === 'LLM_REQUEST_FAILED'
      && error?.status === 400
      && error?.retryable === true
      && error?.responseDetail === 'temporary model gateway rejection'
      && error?.message.includes('temporary model gateway rejection')
    ),
  )
})

test('gateway 400 shrinks request batches before lowering concurrency', async () => {
  const { tuneLlmRuntimeAfterRequestFailure } = await import('../server/genQueue.js')
  const update = tuneLlmRuntimeAfterRequestFailure({
    llmModel: 'gemma-4-31b-it',
    llmBatchSize: 20,
    llmConcurrency: 5,
    llmFallbackModels: ['qwen3.6-27b'],
  }, { status: 400 })

  assert.equal(update.llmBatchSize, 10)
  assert.equal(update.llmConcurrency, 5)
  assert.match(update.reason, /HTTP 400/)
})

test('gateway access rejection rotates models without lowering concurrency', async () => {
  const { tuneLlmRuntimeAfterRequestFailure } = await import('../server/genQueue.js')
  const update = tuneLlmRuntimeAfterRequestFailure({
    llmModel: 'test-model',
    llmBatchSize: 20,
    llmConcurrency: 5,
    llmFallbackModels: ['fallback-one'],
  }, { status: 401 })

  assert.equal(update.llmModel, 'fallback-one')
  assert.equal(update.llmBatchSize, 20)
  assert.equal(update.llmConcurrency, 5)
  assert.deepEqual(update.llmFallbackModels, ['test-model'])
  assert.match(update.reason, /HTTP 401/)
})

test('partial progress keeps runtime capacity when another request times out', async () => {
  const { tuneLlmRuntimeAfterRequestFailure } = await import('../server/genQueue.js')
  const update = tuneLlmRuntimeAfterRequestFailure({
    llmModel: 'test-model',
    llmBatchSize: 20,
    llmConcurrency: 4,
    llmFallbackModels: ['fallback-one'],
  }, {}, { madeProgress: true })

  assert.equal(update.llmModel, 'test-model')
  assert.equal(update.llmBatchSize, 20)
  assert.equal(update.llmConcurrency, 4)
  assert.match(update.reason, /保持当前参数/)
})

test('automatic fallback order keeps low-capacity models at the end', async () => {
  const { orderWorksheetFallbackModels } = await import('../server/genEngine.js')

  assert.deepEqual(
    orderWorksheetFallbackModels(['Qwen/Qwen3.5-4B', 'qwen3.6-27b', 'Qwen/Qwen3-8B', 'gemma-4-31b-it']),
    ['qwen3.6-27b', 'gemma-4-31b-it', 'Qwen/Qwen3.5-4B', 'Qwen/Qwen3-8B'],
  )
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

test('cloze generation falls back to an exact-word truth sentence', async () => {
  const { buildClozeSentence } = await import('../server/genEngine.js')

  assert.equal(
    buildClozeSentence({
      fullSentence: 'The outage disrupted the entire lesson.',
      fallbackSentences: [
        'Disrupt means to interrupt the normal course of something.',
        'Disrupt means to make everything continue normally.',
      ],
    }, 'disrupt'),
    '______ means to interrupt the normal course of something.',
  )
})

test('batch copies use independent numbered archive names', async () => {
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const result = await generateWorksheetArchive({
    rows: [
      { english: 'variation', chinese: '变化' },
      { english: 'association', chinese: '联系' },
      { english: 'standardize', chinese: '使标准化' },
    ],
    fileName: '批量测试.xlsx',
    questionTypes: ['五_缺字母填空'],
    generationMode: 'legacy_zip',
    variationSeed: 'batch-id:1',
    exportSuffix: '第01份',
  })

  assert.equal(result.fileName, '批量测试 练习包 第01份.zip')
  assert.ok(result.buffer.length > 0)
})

test('nine batch variation seeds produce nine unique fixed-test-paper question sets', async () => {
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture()

  const generateCopy = (variationSeed) => generateWorksheetArchive({
    rows,
    fileName: '同配置批量测试.xlsx',
    generationMode: 'fixed_test_paper',
    testPaperGroupSizes: [100, 50, 0, 500],
    withChineseTranslation: false,
    initialCache,
    variationSeed,
    exportSuffix: '第01份',
  })
  const copies = await Promise.all(
    Array.from({ length: 9 }, (_, index) => generateCopy(`batch-id:${index + 1}`)),
  )
  const questionSets = copies.map((copy) => {
    const docx = findStoredZipEntry(copy.buffer, (name) => name.endsWith('.docx'))
    assert.ok(docx)
    const questionXml = findStoredZipEntry(docx, (name) => name === 'word/document.xml')
    assert.ok(questionXml)
    return questionXml.toString('utf8')
  })
  assert.equal(new Set(questionSets).size, 9)
  assert.match(questionSets[0], /<w:cols w:num="1"/)
  assert.doesNotMatch(questionSets[0], /<w:cols w:num="2"/)
})

test('legacy matching worksheet aligns two-row options and keeps optional Chinese', async () => {
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture(12)
  const generate = (withChineseTranslation) => generateWorksheetArchive({
    rows,
    fileName: '双栏释义匹配测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['一_释义匹配'],
    legacyQuestionCount: 12,
    withChineseTranslation,
    initialCache,
  })

  const [withChinese, withoutChinese] = await Promise.all([generate(true), generate(false)])
  const readQuestionXml = (result) => {
    const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith('/一_释义匹配.docx'))
    assert.ok(docx)
    const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml')
    assert.ok(xml)
    return xml.toString('utf8')
  }
  const withChineseXml = readQuestionXml(withChinese)
  const withoutChineseXml = readQuestionXml(withoutChinese)

  assert.match(withChineseXml, /<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"\/>/)
  assert.match(withChineseXml, /<w:cols w:num="2" w:space="360"\/>/)

  // 长选项使用 AB / CD 两行，并共享第二列制表位以保证 A/C、B/D 对齐。
  const optionTables = withChineseXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []
  assert.equal(optionTables.length, 0)
  const paragraphs = withChineseXml.match(/<w:p>[\s\S]*?<\/w:p>/g) || []
  const abRows = paragraphs.filter((item) => item.includes('A. sampleword') && item.includes('B. sampleword'))
  const cdRows = paragraphs.filter((item) => item.includes('C. sampleword') && item.includes('D. sampleword'))
  assert.equal(abRows.length, 12)
  assert.equal(cdRows.length, 12)
  abRows.forEach((row, index) => {
    const abPosition = row.match(/<w:tab w:val="left" w:pos="(\d+)"\/>/)?.[1]
    const cdPosition = cdRows[index].match(/<w:tab w:val="left" w:pos="(\d+)"\/>/)?.[1]
    assert.ok(abPosition)
    assert.equal(abPosition, cdPosition)
    assert.match(row, /<w:tab\/>/)
    assert.match(cdRows[index], /<w:tab\/>/)
  })

  const englishStart = withChineseXml.search(/definition for item \d+/)
  assert.ok(englishStart >= 0)
  const englishEnd = withChineseXml.indexOf('</w:p>', englishStart)
  const translationStart = withChineseXml.indexOf('<w:p>', englishEnd)
  const translationEnd = withChineseXml.indexOf('</w:p>', translationStart)
  const firstOptionStart = withChineseXml.indexOf('A. sampleword', translationEnd)
  assert.match(withChineseXml.slice(translationStart, translationEnd), /第一题译文\d+/)
  assert.ok(translationEnd < firstOptionStart)
  assert.doesNotMatch(withoutChineseXml, /第一题译文\d+/)

  const englishInstruction = withChineseXml.indexOf('Match each definition with the correct word.')
  const chineseInstruction = withChineseXml.indexOf('根据英文释义，从方框中选出正确单词。')
  assert.ok(englishInstruction >= 0 && chineseInstruction > englishInstruction)
  assert.ok(withChineseXml.indexOf('</w:p>', englishInstruction) < chineseInstruction)
})

test('legacy short options stay on one aligned row', async () => {
  process.env.VIVI_LLM_MODEL ||= 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const words = ['cat', 'dog', 'sun', 'sky']
  const rows = words.map((english, index) => ({ english, chinese: `词义${index + 1}` }))
  const initialCache = { lexical: {} }
  rows.forEach(({ english, chinese }, index) => {
    initialCache.lexical[`${english}||${chinese}`] = {
      definitionEn: `short definition ${index + 1}`,
      definitionZh: `短释义${index + 1}`,
      synonym: `similar${index + 1}`,
      antonym: `opposite${index + 1}`,
    }
  })

  const result = await generateWorksheetArchive({
    rows,
    fileName: '短选项测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['一_释义匹配'],
    legacyQuestionCount: 4,
    initialCache,
  })
  const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith('/一_释义匹配.docx'))
  const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml').toString('utf8')
  const optionRows = (xml.match(/<w:p>[\s\S]*?<\/w:p>/g) || [])
    .filter((item) => item.includes('A. ') && item.includes('D. '))

  assert.equal(optionRows.length, 4)
  optionRows.forEach((row) => {
    assert.equal((row.match(/<w:tab\/>/g) || []).length, 3)
    assert.equal((row.match(/<w:tab w:val="left"/g) || []).length, 3)
  })
})

test('archive-style spelling and true-false questions use dense Letter two-column typography', async () => {
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const rows = Array.from({ length: 55 }, (_, index) => {
    const first = String.fromCharCode(97 + Math.floor(index / 26))
    const second = String.fromCharCode(97 + (index % 26))
    return { english: `word${first}${second}`, chinese: `词义${index + 1}` }
  })
  const initialCache = { basic: {} }
  rows.forEach(({ english, chinese }, index) => {
    initialCache.basic[`${english}||${chinese}`] = {
      clozeSentence: `Use ______ in sentence ${index + 1}.`,
      tfTrue: `The true statement for item ${index + 1}.`,
      tfFalse: `The false statement for item ${index + 1}.`,
    }
  })

  const result = await generateWorksheetArchive({
    rows,
    fileName: '参考包紧凑排版.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['四_乱序拼写', '五_缺字母填空', '九_判断正误'],
    legacyQuestionCount: 10,
    initialCache,
  })

  const readPart = (questionKey, partName, answer = false) => {
    const suffix = `/${questionKey}${answer ? '答案' : ''}.docx`
    const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith(suffix))
    assert.ok(docx, `missing ${suffix}`)
    const part = findStoredZipEntry(docx, (name) => name === partName)
    assert.ok(part, `missing ${partName} in ${suffix}`)
    return part.toString('utf8')
  }

  const questionKeys = ['四_乱序拼写', '五_缺字母填空', '九_判断正误']
  questionKeys.forEach((questionKey) => {
    const xml = readPart(questionKey, 'word/document.xml')
    const styles = readPart(questionKey, 'word/styles.xml')
    assert.match(xml, /<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"\/>/)
    assert.match(xml, /<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"\/>/)
    assert.match(xml, /<w:cols w:num="2" w:space="720"\/>/)
    assert.doesNotMatch(xml, /<w:pageBreakBefore\/>/)
    assert.match(xml, /第 2 组（第51～55词）/)
    assert.match(xml, /<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/>/)
    assert.match(xml, /<w:keepLines\/>/)
    assert.ok((xml.match(/<w:keepNext\/>/g) || []).length >= 20)
    assert.match(styles, /w:ascii="Times New Roman"/)
    assert.match(styles, /w:eastAsia="宋体"/)
    assert.match(styles, /<w:sz w:val="24"\/>/)

    const answerXml = readPart(questionKey, 'word/document.xml', true)
    assert.match(answerXml, /<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"\/>/)
    assert.match(answerXml, /<w:cols w:num="1" w:space="360"\/>/)
  })

  const scrambleXml = readPart('四_乱序拼写', 'word/document.xml')
  const missingXml = readPart('五_缺字母填空', 'word/document.xml')
  const trueFalseXml = readPart('九_判断正误', 'word/document.xml')
  assert.match(scrambleXml, /四\. Word Scramble 单词乱序拼写题/)
  assert.match(scrambleXml, /→ ____________/)
  assert.match(scrambleXml, /<w:b\/>/)
  assert.doesNotMatch(missingXml, /<w:b\/>/)
  assert.match(trueFalseXml, /九\. True or False 判断正误/)
  assert.match(trueFalseXml, /<w:b\/>/)
})

test('archive-style synonym replacement keeps each stem rewrite and option block together', async () => {
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture(55)
  const result = await generateWorksheetArchive({
    rows,
    fileName: '同义替换题块测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['三_同义替换'],
    legacyQuestionCount: 4,
    initialCache,
  })
  const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith('/三_同义替换.docx'))
  const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml').toString('utf8')
  const styles = findStoredZipEntry(docx, (name) => name === 'word/styles.xml').toString('utf8')
  const paragraphs = xml.match(/<w:p>[\s\S]*?<\/w:p>/g) || []
  const originalRows = paragraphs.filter((item) => item.includes('The original sentence contains'))
  const rewriteRows = paragraphs.filter((item) => item.includes('The rewritten sentence contains'))
  const optionRows = paragraphs.filter((item) => item.includes('A. ') && item.includes('B. '))

  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"\/>/)
  assert.match(xml, /<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="1134" w:header="720" w:footer="720" w:gutter="0"\/>/)
  assert.match(xml, /<w:cols w:num="2" w:space="720"\/>/)
  assert.equal((xml.match(/<w:pageBreakBefore\/>/g) || []).length, 1)
  assert.equal(originalRows.length, 8)
  assert.equal(rewriteRows.length, 8)
  assert.ok(optionRows.length >= 8)
  originalRows.forEach((row) => {
    assert.match(row, /<w:keepNext\/>/)
    assert.match(row, /<w:keepLines\/>/)
  })
  rewriteRows.forEach((row) => {
    assert.match(row, /<w:keepNext\/>/)
    assert.match(row, /<w:keepLines\/>/)
  })
  optionRows.forEach((row) => assert.match(row, /<w:keepLines\/>/))
  assert.match(styles, /w:ascii="Times New Roman"/)
  assert.match(styles, /w:eastAsia="宋体"/)
})

test('legacy answers flow between groups in aligned ten-column rows', async () => {
  process.env.VIVI_LLM_MODEL ||= 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture(55)
  const result = await generateWorksheetArchive({
    rows,
    fileName: '答案连续排版测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['六_同义反义辨析'],
    legacyQuestionCount: 12,
    initialCache,
  })
  const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith('/六_同义反义辨析答案.docx'))
  const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml').toString('utf8')
  const answerTables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []

  assert.match(xml, /第1组 五 同义反义辨析 答案/)
  assert.match(xml, /第2组 五 同义反义辨析 答案/)
  assert.doesNotMatch(xml, /<w:pageBreakBefore\/>/)
  assert.equal(answerTables.length, 2)
  answerTables.forEach((answerTable) => {
    const grid = answerTable.match(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/)?.[1] || ''
    assert.equal((grid.match(/<w:gridCol /g) || []).length, 10)
    assert.match(answerTable, /<w:tblLayout w:type="fixed"\/>/)
  })
})

test('legacy synonym-antonym judge remains a single-column worksheet', async () => {
  process.env.VIVI_LLM_MODEL ||= 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture(20)
  const result = await generateWorksheetArchive({
    rows,
    fileName: '单栏匹配测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes: ['六_同义反义辨析'],
    legacyQuestionCount: 10,
    initialCache,
  })
  const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith('/六_同义反义辨析.docx'))
  const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml').toString('utf8')
  assert.match(xml, /<w:cols w:num="1"/)
})

test('legacy synonym and antonym matching follow the spaced two-column template', async () => {
  process.env.VIVI_LLM_MODEL ||= 'test-model'
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const { rows, initialCache } = buildFixedTestPaperFixture(55)
  const questionTypes = ['七_同义词匹配', '八_反义词匹配']
  const result = await generateWorksheetArchive({
    rows,
    fileName: '双栏匹配模板测试.xlsx',
    generationMode: 'legacy_zip',
    questionTypes,
    legacyQuestionCount: 10,
    initialCache,
  })

  questionTypes.forEach((questionKey) => {
    const docx = findStoredZipEntry(result.buffer, (name) => name.endsWith(`/${questionKey}.docx`))
    const xml = findStoredZipEntry(docx, (name) => name === 'word/document.xml').toString('utf8')
    const styles = findStoredZipEntry(docx, (name) => name === 'word/styles.xml').toString('utf8')
    const sectionHeading = questionKey.startsWith('七_')
      ? '七. Synonym Matching 同义词匹配'
      : '八. Antonym Matching 反义词匹配'
    const instruction = questionKey.startsWith('七_')
      ? 'Match each word with its synonym on the right.'
      : 'Match each word with its antonym on the right.'
    const blankBlockSpacer = /<w:p><w:pPr><w:keepNext\/><w:keepLines\/><w:jc w:val="left"\/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/><\/w:pPr>(?:<w:r><w:br w:type="column"\/><\/w:r>)?<\/w:p>/g

    assert.match(xml, /<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"\/>/)
    assert.match(xml, /<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"\/>/)
    assert.match(xml, /<w:cols w:num="2" w:space="720"\/>/)
    assert.equal(xml.split(sectionHeading).length - 1, 1)
    assert.equal(xml.split(instruction).length - 1, 1)
    assert.equal((xml.match(/<w:pageBreakBefore\/>/g) || []).length, 1)
    assert.equal((xml.match(blankBlockSpacer) || []).length, 4)
    assert.equal((xml.match(/<w:br w:type="column"\/>/g) || []).length, 2)
    assert.equal((xml.match(/<w:tab w:val="left" w:pos="2520"\/>/g) || []).length, 20)
    assert.equal((xml.match(/<w:tab\/>/g) || []).length, 20)
    assert.equal((xml.match(/<w:tbl>/g) || []).length, 0)
    assert.match(styles, /w:ascii="Times New Roman"/)

    const answerDocx = findStoredZipEntry(result.buffer, (name) => name.endsWith(`/${questionKey}答案.docx`))
    const answerXml = findStoredZipEntry(answerDocx, (name) => name === 'word/document.xml').toString('utf8')
    assert.equal((answerXml.match(/<w:tbl>/g) || []).length, 2)
    assert.match(answerXml, /<w:tblLayout w:type="fixed"\/>/)
  })
})

test('request retry count resets after meaningful progress', async () => {
  const { getLlmRequestRetryState } = await import('../server/genQueue.js')
  const stalled = getLlmRequestRetryState({
    llmRequestRetries: 3,
    llmRequestRetryProgressMark: '0:0:200',
    progress: { completedSteps: 0, currentStep: 'warmup', stageWordCompleted: 200 },
  })
  const advanced = getLlmRequestRetryState({
    llmRequestRetries: 7,
    llmRequestRetryProgressMark: '0:0:200',
    progress: { completedSteps: 0, currentStep: 'warmup', stageWordCompleted: 220 },
  })
  const waitingLabelOnly = getLlmRequestRetryState({
    llmRequestRetries: 7,
    llmRequestRetryProgressMark: '0:0:200',
    progress: { completedSteps: 0, currentStep: '等待 LLM 网关恢复', stageWordCompleted: 200 },
  })

  assert.equal(stalled.retryCount, 3)
  assert.equal(advanced.retryCount, 0)
  assert.equal(waitingLabelOnly.retryCount, 7)
  assert.equal(advanced.progressMark, '0:0:220')
})

test('stage progress does not jump backward after a retry wait', async () => {
  const { progressFromEvent } = await import('../server/genQueue.js')
  const job = {
    progress: {
      totalSteps: 40,
      completedSteps: 2,
      currentStep: '等待限流恢复',
      stageLabel: '预热 LLM 同义替换题面材料',
      stageWordCompleted: 90,
      stageWordTotal: 330,
      percent: 6,
      completedStepKeys: ['warmup:lexical', 'warmup:basic'],
    },
  }

  const resumed = progressFromEvent(job, {
    currentStep: '预热 LLM 同义替换题面材料',
    stageLabel: '预热 LLM 同义替换题面材料',
    stageWordCompleted: 0,
    stageWordTotal: 330,
  })
  const nextStage = progressFromEvent({ ...job, progress: resumed }, {
    currentStep: '生成测试卷',
    stageLabel: '生成测试卷',
    stageWordCompleted: 0,
    stageWordTotal: 1100,
  })

  assert.equal(resumed.stageWordCompleted, 90)
  assert.equal(nextStage.stageWordCompleted, 0)
})

test('resumed synonym stages report their cached entry count', async () => {
  const { countCachedEntries } = await import('../server/genEngine.js')
  const entries = [{ key: 'alpha' }, { key: 'beta' }, { key: 'gamma' }]
  const cache = new Map([['alpha', {}], ['gamma', {}]])

  assert.equal(countCachedEntries(entries, cache), 2)
})

test('request failures switch to durable recovery waits instead of exhausting retries', async () => {
  const { getLlmRequestRetryDelayMs } = await import('../server/genQueue.js')

  assert.equal(getLlmRequestRetryDelayMs(0), 3000)
  assert.equal(getLlmRequestRetryDelayMs(7), 24000)
  assert.equal(getLlmRequestRetryDelayMs(8), 300000)
  assert.equal(getLlmRequestRetryDelayMs(9), 600000)
  assert.equal(getLlmRequestRetryDelayMs(100), 900000)
})

test('validation failures switch to durable recovery waits instead of exhausting retries', async () => {
  const { getLlmValidationRetryDelayMs } = await import('../server/genQueue.js')

  assert.equal(getLlmValidationRetryDelayMs(0), 3000)
  assert.equal(getLlmValidationRetryDelayMs(1), 6000)
  assert.equal(getLlmValidationRetryDelayMs(2), 15000)
  assert.equal(getLlmValidationRetryDelayMs(3), 30000)
  assert.equal(getLlmValidationRetryDelayMs(100), 45000)
})

test('batch recovery identifies deleted copy records for reconstruction', async () => {
  const { getMissingBatchCopyIndexes } = await import('../server/genQueue.js')

  assert.deepEqual(
    getMissingBatchCopyIndexes([
      { copyIndex: 1 },
      { copyIndex: 2 },
      { copyIndex: 4 },
      { copyIndex: 6 },
    ], 6),
    [3, 5],
  )
})

test('batch recovery resets degraded runtime only when no cache remains', async () => {
  const { getWorksheetRecoveryRuntime } = await import('../server/genQueue.js')

  assert.equal(getWorksheetRecoveryRuntime({ lexical: {} }), null)
  assert.ok(getWorksheetRecoveryRuntime({ lexical: {} }, { forceReset: true })?.model)
  const resetRuntime = getWorksheetRecoveryRuntime(null)
  assert.ok(resetRuntime?.model)
  assert.ok(resetRuntime?.batchSize >= 1)
  assert.ok(resetRuntime?.concurrency >= 1)
})

test('explicit runtime reset also rewrites queued jobs during workflow migration', async () => {
  const { shouldRewriteWorksheetJobForMigration } = await import('../server/genQueue.js')

  assert.equal(shouldRewriteWorksheetJobForMigration('queued'), false)
  assert.equal(shouldRewriteWorksheetJobForMigration('queued', { resetRuntime: true }), true)
  assert.equal(shouldRewriteWorksheetJobForMigration('processing'), true)
  assert.equal(shouldRewriteWorksheetJobForMigration('completed', { resetRuntime: true }), false)
  assert.equal(shouldRewriteWorksheetJobForMigration('completed', { forceRewrite: true }), true)
})

test('single jobs can be selected for migration without a batch id', async () => {
  const { shouldRewriteWorksheetJobForMigration } = await import('../server/genQueue.js')

  assert.equal(shouldRewriteWorksheetJobForMigration('processing', { forceRewrite: true }), true)
  assert.equal(shouldRewriteWorksheetJobForMigration('queued', { forceRewrite: true }), true)
})

test('cache recovery fills missing entries while preserving target results', async () => {
  const { mergeWorksheetCacheValues } = await import('../server/genQueue.js')
  const merged = mergeWorksheetCacheValues({
    lexical: { alpha: { value: 'source-alpha' }, beta: { value: 'source-beta' } },
    basic: { alpha: { value: 'source-basic' } },
  }, {
    lexical: { alpha: { value: 'target-alpha' } },
    synonym: { gamma: { value: 'target-synonym' } },
  })

  assert.equal(merged.lexical.alpha.value, 'target-alpha')
  assert.equal(merged.lexical.beta.value, 'source-beta')
  assert.equal(merged.basic.alpha.value, 'source-basic')
  assert.equal(merged.synonym.gamma.value, 'target-synonym')
})

test('cache checkpoints require the active worksheet execution lease', async () => {
  const { hasWorksheetExecutionLease } = await import('../server/genQueue.js')

  assert.equal(hasWorksheetExecutionLease({ executionLeaseId: 'new-lease' }, 'new-lease'), true)
  assert.equal(hasWorksheetExecutionLease({ executionLeaseId: 'old-lease' }, 'new-lease'), false)
  assert.equal(hasWorksheetExecutionLease({}, ''), false)
})

test('rate limit retry count resets after meaningful progress', async () => {
  const { getLlmRateLimitRetryState } = await import('../server/genQueue.js')
  const stalled = getLlmRateLimitRetryState({
    llmRateLimitRetries: 6,
    llmRateLimitRetryProgressMark: '0:0:913',
    progress: { completedSteps: 0, currentStep: 'warmup', stageWordCompleted: 913 },
  })
  const advanced = getLlmRateLimitRetryState({
    llmRateLimitRetries: 6,
    llmRateLimitRetryProgressMark: '0:0:913',
    progress: { completedSteps: 0, currentStep: 'warmup', stageWordCompleted: 922 },
  })

  assert.equal(stalled.retryCount, 6)
  assert.equal(advanced.retryCount, 0)
  assert.equal(advanced.progressMark, '0:0:922')
})

test('validation retry count resets for a new stage or meaningful progress', async () => {
  const { getLlmValidationRetryState } = await import('../server/genQueue.js')
  const stalled = getLlmValidationRetryState({
    llmValidationRetries: 2,
    llmValidationRetryProgressMark: '2:0:0:warmup:synonym',
    progress: { completedSteps: 2, currentStep: 'warmup:synonym', stageWordCompleted: 0 },
  })
  const nextStage = getLlmValidationRetryState({
    llmValidationRetries: 2,
    llmValidationRetryProgressMark: '0:0:1450:warmup:base',
    progress: { completedSteps: 2, currentStep: 'warmup:synonym', stageWordCompleted: 0 },
  })

  assert.equal(stalled.retryCount, 2)
  assert.equal(nextStage.retryCount, 0)
  assert.equal(nextStage.progressMark, '2:0:0:warmup:synonym')
})

test('degraded LLM runtimes cap each Workflow step by request rounds', async () => {
  const { getLlmEntryLimitForRuntime } = await import('../server/genQueue.js')

  assert.equal(getLlmEntryLimitForRuntime({ llmBatchSize: 1, llmConcurrency: 1 }, 100), 3)
  assert.equal(getLlmEntryLimitForRuntime({ llmBatchSize: 2, llmConcurrency: 1 }, 100), 6)
  assert.equal(getLlmEntryLimitForRuntime({ llmBatchSize: 5, llmConcurrency: 2 }, 100), 30)
  assert.equal(getLlmEntryLimitForRuntime({ llmBatchSize: 20, llmConcurrency: 5 }, 100), 100)
})

test('workflow steps yield before the serverless function hard timeout', async () => {
  const { hasWorksheetStepTimeBudget, shouldYieldWorksheetStep } = await import('../server/genQueue.js')

  assert.equal(hasWorksheetStepTimeBudget(1_000, 180_999, 180_000), true)
  assert.equal(hasWorksheetStepTimeBudget(1_000, 181_000, 180_000), false)
  assert.equal(shouldYieldWorksheetStep(false, 1_000, 181_000, 180_000), true)
  assert.equal(shouldYieldWorksheetStep(true, 1_000, 181_000, 180_000), false)
})

test('rendering starts only after cached LLM preparation has completed', async () => {
  const { rows, initialCache } = buildFixedTestPaperFixture(30)
  const { generateWorksheetArchive } = await import('../server/genEngine.js')
  const events = []

  const result = await generateWorksheetArchive({
    rows,
    fileName: 'render-phase-test.xlsx',
    generationMode: 'fixed_test_paper',
    testPaperGroupSizes: [30],
    initialCache,
    onProgress: async (progress) => {
      events.push(progress.currentStep)
    },
    onRenderStart: async () => {
      events.push('render-start')
    },
  })

  const renderStartIndex = events.indexOf('render-start')
  assert.ok(renderStartIndex > 0)
  assert.ok(events.slice(0, renderStartIndex).some((step) => String(step).startsWith('预热 LLM')))
  assert.equal(events[renderStartIndex + 1], '生成测试卷')
  assert.ok(result.buffer.length > 0)
})
