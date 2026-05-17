import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import QRCode from 'qrcode'
import {
  Archive,
  Headphones,
  Loader2,
  Lock,
  LogOut,
  Pause,
  Play,
  QrCode,
  Radio,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react'
import { apiJson, fetchAudioBlob } from './api'
import { clampInt } from './utils'
import {
  DEFAULT_TTS_CONFIG,
  base64ToBlob,
  blobToBase64,
  chunkWords,
  downloadNamedBlob,
  getSpeechSupport,
  isEdgeBrowser,
  speakWordsLocally,
  splitWords,
  uniqueKeepOrder,
} from './ttsUtils'
import {
  deleteAudioSession,
  listAudioSessions,
  loadAudioSession,
  saveAudioSession,
  updateAudioSessionShare,
} from './ttsLibrary'

const readFileAsArrayBuffer = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })

const defaultVoices = {
  azure: [
    { id: 'en-US-JennyNeural', name: 'Jenny · US · Female', accent: 'us', provider: 'azure' },
    { id: 'en-US-GuyNeural', name: 'Guy · US · Male', accent: 'us', provider: 'azure' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia · UK · Female', accent: 'gb', provider: 'azure' },
    { id: 'en-GB-RyanNeural', name: 'Ryan · UK · Male', accent: 'gb', provider: 'azure' },
  ],
  edge: [
    { id: 'en-US-JennyNeural', name: 'Jenny · US · Female', accent: 'us', provider: 'edge' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia · UK · Female', accent: 'gb', provider: 'edge' },
  ],
}

const getAudioEndpoint = (provider) => (provider === 'edge' ? '/api/tts/edge' : '/api/tts/azure')

const pad3 = (value) => String(Math.max(1, Number.parseInt(value, 10) || 1)).padStart(3, '0')

const sanitizeFilePart = (value, fallback = 'word') => {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

const buildBatchMeta = (batch, index, offset = 0) => {
  const firstWord = batch[0] || 'word'
  const lastWord = batch[batch.length - 1] || firstWord
  const wordCount = batch.length || 1
  const firstSlug = sanitizeFilePart(firstWord)
  const lastSlug = sanitizeFilePart(lastWord, firstSlug)
  const batchNo = index + 1
  const slug = firstSlug === lastSlug
    ? `${pad3(batchNo)}_${firstSlug}_${wordCount}w`
    : `${pad3(batchNo)}_${firstSlug}-to-${lastSlug}_${wordCount}w`
  const rangeText = offset + 1 === offset + wordCount ? `第 ${offset + 1} 个` : `第 ${offset + 1}-${offset + wordCount} 个`

  return {
    batchNo,
    firstWord,
    lastWord,
    wordCount,
    fileStem: slug,
    title: `B${pad3(batchNo)} · ${firstWord}${firstWord === lastWord ? '' : ` → ${lastWord}`}`,
    subtitle: `${rangeText} · ${wordCount} 词`,
  }
}

const createSessionId = () => {
  if (crypto?.randomUUID) return crypto.randomUUID()
  return `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const buildSessionTitle = (sourceName, generatedAt = Date.now()) => {
  const base = String(sourceName || '单词朗读').replace(/\.[^.]+$/, '') || '单词朗读'
  return `${base} · ${new Date(generatedAt).toLocaleString('zh-CN')}`
}

const LAST_SESSION_KEY = 'xlsx2pdf_tts_last_session_id'

const SelectField = ({ label, value, onChange, children }) => (
  <label className="field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  </label>
)

const NumberField = ({ label, value, onChange, min, max, suffix }) => {
  const [draft, setDraft] = useState(String(value ?? ''))

  useEffect(() => {
    setDraft(String(value ?? ''))
  }, [value])

  const commit = () => {
    const normalized = clampInt(draft, min, max, value)
    onChange(normalized)
    setDraft(String(normalized))
  }

  return (
    <label className="field">
      <span>{label}</span>
      <div className="inputShell">
        <input
          type="number"
          min={min}
          max={max}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </label>
  )
}

const RangeField = ({ label, value, min, max, step = 1, suffix, onChange }) => (
  <label className="rangeField">
    <span>
      {label}
      <strong>
        {value}
        {suffix}
      </strong>
    </span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </label>
)

function WordSummary({ words = [] }) {
  const fullText = words.join(' · ')
  const preview = words.slice(0, 3).join(' / ')

  return (
    <div className="wordSummary" title={fullText}>
      <span>{words.length} 个单词</span>
      <strong>{preview || '暂无单词'}</strong>
      {words.length > 3 ? <em>+{words.length - 3}</em> : null}
    </div>
  )
}

function SegmentedAudioPlayer({ item }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef(null)
  const timerRef = useRef(null)
  const current = item.segments[index]

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current || !playing) return
    audio.src = current.url
    audio.currentTime = 0
    audio.play().catch(() => setPlaying(false))
  }, [current, playing])

  const stop = () => {
    window.clearTimeout(timerRef.current)
    audioRef.current?.pause()
    setPlaying(false)
  }

  const toggle = () => {
    if (playing) {
      stop()
      return
    }
    if (index >= item.segments.length) setIndex(0)
    setPlaying(true)
  }

  const handleEnded = () => {
    if (index >= item.segments.length - 1) {
      setPlaying(false)
      setIndex(0)
      return
    }
    timerRef.current = window.setTimeout(() => {
      setIndex((currentIndex) => currentIndex + 1)
    }, item.pauseMs || 0)
  }

  return (
    <div className="segmentedPlayer">
      <audio ref={audioRef} onEnded={handleEnded} preload="metadata" />
      <div>
        <button type="button" onClick={toggle}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? '暂停分段播放' : '播放分段音频'}
        </button>
        <small>
          {current?.word || item.segments[0]?.word || '等待播放'} · {index + 1}/{item.segments.length} · 停顿 {item.pauseMs}ms
        </small>
      </div>
    </div>
  )
}

function TtsWorkspace({ rows, loadWorkbook, fileName, activeSheetName }) {
  const [authenticated, setAuthenticated] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [voices, setVoices] = useState(defaultVoices)
  const [config, setConfig] = useState(DEFAULT_TTS_CONFIG)
  const [wordText, setWordText] = useState('')
  const [status, setStatus] = useState('输入访问密码后即可使用 Azure TTS。')
  const [audioItems, setAudioItems] = useState([])
  const [busy, setBusy] = useState(false)
  const [qrUrl, setQrUrl] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [selectedAudioIndex, setSelectedAudioIndex] = useState(0)
  const [currentSessionId, setCurrentSessionId] = useState('')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const [playlistClosing, setPlaylistClosing] = useState(false)
  const [libraryItems, setLibraryItems] = useState([])
  const [restoreChecked, setRestoreChecked] = useState(false)
  const [localSpeaking, setLocalSpeaking] = useState(false)
  const [localWord, setLocalWord] = useState('')
  const ttsFileRef = useRef(null)
  const stopLocalRef = useRef(null)
  const playlistCloseTimerRef = useRef(null)

  const words = useMemo(() => uniqueKeepOrder(splitWords(wordText)), [wordText])
  const batches = useMemo(() => chunkWords(words, config.batchSize), [words, config.batchSize])
  const batchMetas = useMemo(() => {
    let offset = 0
    return batches.map((batch, index) => {
      const meta = buildBatchMeta(batch, index, offset)
      offset += batch.length
      return meta
    })
  }, [batches])
  const currentVoiceList = (voices[config.provider] || []).filter((voice) => voice.accent === config.accent)
  const currentVoice = config.provider === 'edge' ? config.edgeVoice : config.azureVoice
  const isEdge = isEdgeBrowser()
  const safeSelectedAudioIndex = audioItems.length ? Math.min(selectedAudioIndex, audioItems.length - 1) : 0
  const selectedAudioItem = audioItems[safeSelectedAudioIndex] || null
  const selectedWords = selectedAudioItem?.words || []

  useEffect(() => {
    apiJson('/api/auth/me')
      .then((data) => {
        setAuthenticated(Boolean(data.authenticated))
        if (data.authenticated) setStatus('已解锁单词朗读板块。')
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true))
  }, [])

  useEffect(() => {
    if (!authenticated) return
    apiJson('/api/tts/voices')
      .then((data) => {
        setVoices({ azure: data.azure || defaultVoices.azure, edge: data.edge || defaultVoices.edge })
        setStatus('已载入音色列表，Azure 为优先生成通道。')
      })
      .catch((err) => setStatus(`音色列表读取失败，使用内置音色：${err.message}`))
  }, [authenticated])

  useEffect(() => {
    if (!authenticated) return
    listAudioSessions()
      .then(setLibraryItems)
      .catch(() => setLibraryItems([]))
  }, [authenticated])

  useEffect(() => {
    if (!currentVoiceList.length) return
    const key = config.provider === 'edge' ? 'edgeVoice' : 'azureVoice'
    if (!currentVoiceList.some((voice) => voice.id === config[key])) {
      setConfig((current) => ({ ...current, [key]: currentVoiceList[0].id }))
    }
  }, [config.provider, config.accent, currentVoiceList])

  useEffect(
    () => () => {
      stopLocalRef.current?.()
      window.clearTimeout(playlistCloseTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    if (!shareUrl) {
      setQrUrl('')
      return () => {
        cancelled = true
      }
    }

    QRCode.toDataURL(shareUrl, { width: 360, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setQrUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [shareUrl])

  useEffect(() => {
    if (!audioItems.length) {
      setSelectedAudioIndex(0)
      setPlaylistOpen(false)
      setPlaylistClosing(false)
      return
    }
    setSelectedAudioIndex((index) => Math.min(Math.max(0, index), audioItems.length - 1))
  }, [audioItems.length])

  useEffect(() => {
    if (!authenticated || restoreChecked) return
    setRestoreChecked(true)
    try {
      const lastSessionId = localStorage.getItem(LAST_SESSION_KEY)
      if (lastSessionId) openLibrarySession(lastSessionId)
    } catch {
      // ignore
    }
    // openLibrarySession is intentionally omitted to avoid re-running auto restore after state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, restoreChecked])

  const updateTtsConfig = (patch) => setConfig((current) => ({ ...current, ...patch }))

  const openPlaylist = () => {
    window.clearTimeout(playlistCloseTimerRef.current)
    setPlaylistClosing(false)
    setPlaylistOpen(true)
  }

  const closePlaylist = () => {
    if (!playlistOpen) return
    window.clearTimeout(playlistCloseTimerRef.current)
    setPlaylistClosing(true)
    playlistCloseTimerRef.current = window.setTimeout(() => {
      setPlaylistOpen(false)
      setPlaylistClosing(false)
    }, 170)
  }

  const refreshLibrary = async () => {
    try {
      setLibraryItems(await listAudioSessions())
    } catch (error) {
      setStatus(error.message || '读取本地音频库失败。')
    }
  }

  const rememberLastSession = (sessionId) => {
    try {
      if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId)
    } catch {
      // localStorage 可能被隐私模式禁用，不影响 IndexedDB 音频库本身。
    }
  }

  const persistGeneratedSession = async (items) => {
    if (!items.length) return ''
    const createdAt = Date.now()
    const sessionId = createSessionId()
    const session = {
      id: sessionId,
      title: buildSessionTitle(fileName, createdAt),
      sourceFileName: fileName,
      createdAt,
      totalWords: items.reduce((sum, item) => sum + (item.wordCount || item.words?.length || 0), 0),
      batchCount: items.length,
      provider: config.provider,
      accent: config.accent,
      voice: currentVoice,
      rate: config.rate,
      pauseMs: config.pauseMs,
      batchSize: config.batchSize,
      firstWord: items[0]?.firstWord || items[0]?.words?.[0] || '',
      lastWord: items[items.length - 1]?.lastWord || items[items.length - 1]?.words?.at(-1) || '',
    }
    await saveAudioSession(session, items)
    setCurrentSessionId(sessionId)
    rememberLastSession(sessionId)
    await refreshLibrary()
    return sessionId
  }

  const openLibrarySession = async (sessionId) => {
    setBusy(true)
    setStatus('正在从本地音频库恢复生成记录…')
    try {
      const session = await loadAudioSession(sessionId)
      setAudioItems(session.items)
      setCurrentSessionId(session.id)
      rememberLastSession(session.id)
      setSelectedAudioIndex(0)
      setShareUrl(session.shareUrl || '')
      setQrUrl('')
      setLibraryOpen(false)
      setStatus(`已恢复：${session.title}`)
    } catch (error) {
      setStatus(error.message || '恢复本地生成记录失败。')
    } finally {
      setBusy(false)
    }
  }

  const removeLibrarySession = async (sessionId) => {
    try {
      await deleteAudioSession(sessionId)
      try {
        if (localStorage.getItem(LAST_SESSION_KEY) === sessionId) localStorage.removeItem(LAST_SESSION_KEY)
      } catch {
        // ignore
      }
      if (sessionId === currentSessionId) {
        setCurrentSessionId('')
        setAudioItems([])
        setShareUrl('')
        setQrUrl('')
      }
      await refreshLibrary()
      setStatus('已删除本地生成记录。')
    } catch (error) {
      setStatus(error.message || '删除本地生成记录失败。')
    }
  }

  const login = async (event) => {
    event.preventDefault()
    setLoginError('')
    try {
      await apiJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setAuthenticated(true)
      setPassword('')
      setStatus('已解锁单词朗读板块。')
    } catch (error) {
      setLoginError(error.message || '登录失败。')
    }
  }

  const logout = async () => {
    await apiJson('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => {})
    setAuthenticated(false)
    setAudioItems([])
    setShareUrl('')
    setQrUrl('')
    setSelectedAudioIndex(0)
    setCurrentSessionId('')
    setLibraryOpen(false)
    setPlaylistOpen(false)
    setPlaylistClosing(false)
    setStatus('已退出单词朗读板块。')
  }

  const importWordsFromRows = () => {
    const imported = rows.map((row) => row.english).filter(Boolean).join('\n')
    setWordText(imported)
    setStatus(`已从当前词表导入 ${splitWords(imported).length} 个英文单词。`)
  }

  const loadTtsXlsx = async (file) => {
    await loadWorkbook(file)
    const data = await readFileAsArrayBuffer(file)
    const parsed = XLSX.read(data, { type: 'array', cellDates: true, cellText: true, WTF: false })
    const firstSheet = parsed.Sheets[parsed.SheetNames[0]]
    const matrix = XLSX.utils.sheet_to_json(firstSheet, { header: 1, blankrows: false })
    const imported = matrix
      .map((row) => row.find((cell) => typeof cell === 'string' && /[A-Za-z]/.test(cell)) ?? row[0])
      .map((cell) => String(cell ?? '').trim())
      .filter(Boolean)
      .join('\n')
    setWordText(imported)
    setStatus(`已从 ${file.name} 导入 ${splitWords(imported).length} 个候选单词。`)
  }

  const buildPayload = (batch) => ({
    words: batch,
    provider: config.provider,
    accent: config.accent,
    voice: currentVoice,
    rate: config.rate,
    pauseMs: config.pauseMs,
  })

  const generateEdgeSegmentedBatch = async (batch, index) => {
    const meta = batchMetas[index] || buildBatchMeta(batch, index)
    const data = await apiJson('/api/tts/edge', {
      method: 'POST',
      body: JSON.stringify({ ...buildPayload(batch), segmented: true }),
    })
    const segments = (data.segments || []).map((segment, segmentIndex) => {
      const blob = base64ToBlob(segment.audioBase64, segment.contentType || 'audio/mpeg')
      return {
        word: segment.text,
        fileStem: `${pad3(segmentIndex + 1)}_${sanitizeFilePart(segment.text)}`,
        blob,
        url: URL.createObjectURL(blob),
      }
    })
    if (!segments.length) throw new Error('Edge-TTS 未返回可播放片段。')
    return {
      id: `${Date.now()}-${index}`,
      words: batch,
      label: meta.title,
      ...meta,
      provider: 'edge',
      pauseMs: config.pauseMs,
      segments,
    }
  }

  const generateBatch = async (batch, index) => {
    if (config.provider === 'edge') return generateEdgeSegmentedBatch(batch, index)

    const meta = batchMetas[index] || buildBatchMeta(batch, index)
    const blob = await fetchAudioBlob(getAudioEndpoint(config.provider), buildPayload(batch))
    return {
      id: `${Date.now()}-${index}`,
      blob,
      url: URL.createObjectURL(blob),
      words: batch,
      label: meta.title,
      ...meta,
      provider: config.provider,
    }
  }

  const previewFirstBatch = async () => {
    if (!words.length) return setStatus('请先粘贴或导入单词。')
    setBusy(true)
    setStatus('正在生成首段试听音频…')
    try {
      const item = await generateBatch(batches[0], 0)
      setAudioItems([item])
      setShareUrl('')
      setQrUrl('')
      setSelectedAudioIndex(0)
      await persistGeneratedSession([item])
      setPlaylistOpen(false)
      setPlaylistClosing(false)
      setStatus('试听音频已生成，可在线播放。')
    } catch (error) {
      setStatus(error.message || '试听生成失败。')
    } finally {
      setBusy(false)
    }
  }

  const generateAll = async () => {
    if (!words.length) return setStatus('请先粘贴或导入单词。')
    setBusy(true)
    setAudioItems([])
    setShareUrl('')
    setQrUrl('')
    setSelectedAudioIndex(0)
    setCurrentSessionId('')
    setStatus(`准备生成 ${batches.length} 段音频…`)
    const items = []
    try {
      for (let index = 0; index < batches.length; index += 1) {
        setStatus(`正在生成第 ${index + 1} / ${batches.length} 段…`)
        const item = await generateBatch(batches[index], index)
        items.push(item)
        setAudioItems([...items])
      }
      await persistGeneratedSession(items)
      setStatus('全部音频已生成，并已保存到本机音频库。可在线播放或生成手机二维码。')
    } catch (error) {
      setStatus(error.message || '批量生成失败。')
    } finally {
      setBusy(false)
    }
  }

  const localPreview = () => {
    if (localSpeaking) {
      stopLocalRef.current?.()
      stopLocalRef.current = null
      setLocalSpeaking(false)
      setLocalWord('')
      return
    }
    if (!words.length) return setStatus('请先粘贴或导入单词。')
    if (!isEdge) return setStatus('未检测到 Microsoft Edge，已禁用本机 Edge 试听 fallback。')
    if (!getSpeechSupport()) return setStatus('当前浏览器不支持 Web Speech API。')
    setLocalSpeaking(true)
    setStatus('正在使用本机浏览器朗读试听，不会生成可下载音频。')
    stopLocalRef.current = speakWordsLocally({
      words: batches[0] || [],
      rate: config.rate,
      pauseMs: config.pauseMs,
      accent: config.accent,
      onWord: setLocalWord,
      onDone: () => {
        setLocalSpeaking(false)
        setLocalWord('')
        setStatus('本机试听结束。')
      },
      onError: (error) => {
        setLocalSpeaking(false)
        setStatus(String(error || '本机朗读失败。'))
      },
    })
  }

  const createQrShare = async () => {
    if (!audioItems.length) return setStatus('请先生成音频。')
    setBusy(true)
    setStatus('正在创建分享并上传音频…')
    try {
      const uploadUnits = audioItems.flatMap((item, itemIndex) => {
        if (item.segments?.length) {
          return item.segments.map((segment, segmentIndex) => ({
            blob: segment.blob,
            label: `${item.title || item.label} · ${pad3(segmentIndex + 1)} ${segment.word}`,
            words: [segment.word],
            provider: item.provider,
            delayAfterMs: item.pauseMs || 0,
            segmented: true,
            sourceIndex: itemIndex,
            segmentIndex,
            batchTitle: item.title || item.label,
            batchSubtitle: item.subtitle,
            batchLabel: item.fileStem,
            batchFirstWord: item.firstWord || item.words?.[0],
            batchLastWord: item.lastWord || item.words?.[item.words.length - 1],
            batchWordCount: item.wordCount || item.words?.length || 1,
          }))
        }
        return [{
          blob: item.blob,
          label: item.title || item.label,
          words: item.words,
          provider: item.provider,
          delayAfterMs: 0,
          segmented: false,
          sourceIndex: itemIndex,
          segmentIndex: 0,
          batchTitle: item.title || item.label,
          batchSubtitle: item.subtitle,
          batchLabel: item.fileStem,
          batchFirstWord: item.firstWord || item.words?.[0],
          batchLastWord: item.lastWord || item.words?.[item.words.length - 1],
          batchWordCount: item.wordCount || item.words?.length || 1,
        }]
      })
      if (uploadUnits.length) uploadUnits[uploadUnits.length - 1].delayAfterMs = 0

      const start = await apiJson('/api/share/start', {
        method: 'POST',
        body: JSON.stringify({
          count: uploadUnits.length,
          files: uploadUnits.map((unit) => ({
            sourceIndex: unit.sourceIndex,
            segmentIndex: unit.segmentIndex,
            segmented: unit.segmented,
            word: unit.words?.[0] || unit.label,
            batchFirstWord: unit.batchFirstWord,
            batchLastWord: unit.batchLastWord,
            batchWordCount: unit.batchWordCount,
          })),
        }),
      })

      const tracks = []
      for (let index = 0; index < uploadUnits.length; index += 1) {
        const unit = uploadUnits[index]
        setStatus(`正在通过服务端上传第 ${index + 1} / ${uploadUnits.length} 段音频…`)
        await apiJson('/api/share/upload', {
          method: 'POST',
          body: JSON.stringify({
            key: start.audio[index].key,
            contentType: 'audio/mpeg',
            base64: await blobToBase64(unit.blob),
          }),
        })
        tracks.push({
          key: start.audio[index].key,
          label: unit.label,
          words: unit.words,
          provider: unit.provider,
          delayAfterMs: unit.delayAfterMs,
          sourceIndex: unit.sourceIndex,
          segmentIndex: unit.segmentIndex,
          segmented: unit.segmented,
          batchTitle: unit.batchTitle,
          batchSubtitle: unit.batchSubtitle,
          batchLabel: start.audio[index].batchLabel || unit.batchLabel,
          folder: start.audio[index].folder,
          fileName: start.audio[index].fileName,
        })
      }

      const shareBatches = audioItems.map((item, itemIndex) => {
        const groupedTracks = tracks.filter((track) => track.sourceIndex === itemIndex)
        return {
          sourceIndex: itemIndex,
          title: item.title || item.label,
          subtitle: item.subtitle,
          batchLabel: item.fileStem || groupedTracks[0]?.batchLabel || '',
          firstWord: item.firstWord || item.words?.[0],
          lastWord: item.lastWord || item.words?.[item.words.length - 1],
          wordCount: item.wordCount || item.words?.length || 1,
          trackCount: groupedTracks.length,
          folder: groupedTracks[0]?.folder || '',
        }
      })

      const manifest = {
        title: `${fileName.replace(/\.[^.]+$/, '') || '单词朗读'} · ${new Date().toLocaleString('zh-CN')}`,
        totalWords: words.length,
        batchSize: config.batchSize,
        accent: config.accent,
        voice: currentVoice,
        rate: config.rate,
        pauseMs: config.pauseMs,
        createdAt: new Date().toISOString(),
        expiresAt: start.expiresAt,
        storagePrefix: start.prefix,
        batches: shareBatches,
        tracks,
      }

      await apiJson('/api/share/upload', {
        method: 'POST',
        body: JSON.stringify({
          key: start.manifest.key,
          contentType: 'application/json; charset=utf-8',
          text: JSON.stringify(manifest),
        }),
      })

      await apiJson('/api/share/finalize', { method: 'POST', body: JSON.stringify({ shareId: start.shareId }) })

      const url = `${window.location.origin}/listen?token=${encodeURIComponent(start.token)}`
      const dataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1 })
      setShareUrl(url)
      setQrUrl(dataUrl)
      if (currentSessionId) {
        await updateAudioSessionShare(currentSessionId, {
          shareUrl: url,
          shareToken: start.token,
          expiresAt: start.expiresAt,
        })
        await refreshLibrary()
      }
      setStatus('二维码已生成，手机扫码即可播放。')
    } catch (error) {
      setStatus(error.message || '二维码生成失败。请检查存储环境变量和 CORS。')
    } finally {
      setBusy(false)
    }
  }

  if (!authChecked) {
    return (
      <section className="ttsGate">
        <Loader2 className="spin" size={28} />
        <p>正在检查访问权限…</p>
      </section>
    )
  }

  if (!authenticated) {
    return (
      <section className="ttsGate">
        <div className="gateCard">
          <Lock size={34} />
          <span className="eyebrow">Protected TTS</span>
          <h2>单词朗读音频生成</h2>
          <p>该板块需要访问密码。密码只在服务端环境变量中校验，登录后使用 HttpOnly 会话 Cookie 保护 API。</p>
          <form onSubmit={login}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入访问密码"
              autoComplete="current-password"
            />
            <button className="primaryButton dark" type="submit">
              解锁
            </button>
          </form>
          {loginError ? <strong className="errorText">{loginError}</strong> : null}
        </div>
      </section>
    )
  }

  return (
    <section className="ttsWorkspace">
      <aside className="ttsControls">
        <div className="panelBlock">
          <div className="blockTitle">
            <Headphones size={17} />
            <span>单词来源</span>
          </div>
          <textarea
            className="wordInput"
            value={wordText}
            onChange={(event) => setWordText(event.target.value)}
            placeholder={'每行一个单词，或用逗号/分号分隔\ncheat\nshare\npay phone'}
          />
          <div className="tinyActions">
            <button type="button" onClick={importWordsFromRows}>
              复用当前词表
            </button>
            <button type="button" onClick={() => ttsFileRef.current?.click()}>
              导入 XLSX
            </button>
            <input
              ref={ttsFileRef}
              type="file"
              accept=".xlsx,.xls"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) loadTtsXlsx(file)
                event.target.value = ''
              }}
            />
          </div>
          <p className="statusLine">
            已识别 {words.length} 个单词 · 当前表：{activeSheetName || '示例数据'}
          </p>
        </div>

        <div className="panelBlock">
          <div className="blockTitle">
            <SlidersHorizontal size={17} />
            <span>朗读设置</span>
          </div>
          <SelectField label="生成通道" value={config.provider} onChange={(provider) => updateTtsConfig({ provider })}>
            <option value="azure">Azure API（优先）</option>
            <option value="edge">Edge-TTS 后端 fallback</option>
          </SelectField>
          <SelectField label="英/美音" value={config.accent} onChange={(accent) => updateTtsConfig({ accent })}>
            <option value="us">美音 en-US</option>
            <option value="gb">英音 en-GB</option>
          </SelectField>
          <SelectField
            label="朗读者音色"
            value={currentVoice}
            onChange={(voice) => updateTtsConfig(config.provider === 'edge' ? { edgeVoice: voice } : { azureVoice: voice })}
          >
            {currentVoiceList.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </SelectField>
          <RangeField label="朗读速度" min={-50} max={50} value={config.rate} suffix="%" onChange={(rate) => updateTtsConfig({ rate })} />
          <RangeField
            label="单词间停顿"
            min={0}
            max={3000}
            step={100}
            value={config.pauseMs}
            suffix="ms"
            onChange={(pauseMs) => updateTtsConfig({ pauseMs })}
          />
          <NumberField
            label="单次单词数量"
            value={config.batchSize}
            min={1}
            max={80}
            onChange={(batchSize) => updateTtsConfig({ batchSize })}
            suffix="词"
          />
        </div>

        <button className="exportButton" type="button" onClick={previewFirstBatch} disabled={busy || !words.length}>
          {busy ? <Loader2 className="spin" size={18} /> : <Volume2 size={18} />}
          生成首段试听
        </button>
        <button className="secondaryButton" type="button" onClick={generateAll} disabled={busy || !words.length}>
          <Radio size={18} /> 批量生成音频
        </button>
        <button className="ghostAction" type="button" onClick={localPreview} disabled={!words.length}>
          {localSpeaking ? <Pause size={17} /> : <Play size={17} />}
          {localSpeaking ? `停止本机试听 ${localWord}` : `本机 Edge 试听${isEdge ? '' : '（未检测到）'}`}
        </button>
        <button className="logoutButton" type="button" onClick={logout}>
          <LogOut size={16} /> 退出朗读板块
        </button>
        <p className="statusLine">{status}</p>
      </aside>

      <section className="ttsStage">
        <div className="stageHeader">
          <div>
            <span className="eyebrow">Audio Studio</span>
            <h2>{words.length ? `${words.length} 个单词 · ${batches.length} 段` : '等待单词'}</h2>
          </div>
          <div className="stageActions">
            <button className="libraryButton" type="button" onClick={() => setLibraryOpen(true)}>
              <Archive size={16} /> 管理已生成 {libraryItems.length ? `(${libraryItems.length})` : ''}
            </button>
            <div className="qrActionWrap">
              <button className="qrButton" type="button" onClick={createQrShare} disabled={busy || !audioItems.length}>
                <QrCode size={18} /> 生成手机二维码
              </button>
              <div className="qrPopover" role="status">
                <div className={qrUrl ? 'qrPopoverCard' : 'qrPopoverCard empty'}>
                  {qrUrl ? (
                    <>
                      <img src={qrUrl} alt="手机播放二维码" />
                      <strong>手机播放二维码</strong>
                      <a href={shareUrl} target="_blank" rel="noreferrer">
                        打开播放链接
                      </a>
                      <p>链接带只读签名 token，手机无需再次输入密码。</p>
                    </>
                  ) : (
                    <>
                      <span className="qrPopoverIcon">
                        <QrCode size={24} />
                      </span>
                      <strong>{busy ? '正在生成二维码' : '尚未生成二维码'}</strong>
                      <p>{audioItems.length ? '点击上方按钮生成二维码，生成后会在这里显示。' : '请先生成或恢复音频，再生成手机二维码。'}</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="ttsStats">
          <div>
            <small>通道</small>
            <strong>{config.provider === 'azure' ? 'Azure TTS' : 'Edge-TTS'}</strong>
          </div>
          <div>
            <small>口音</small>
            <strong>{config.accent === 'gb' ? '英音' : '美音'}</strong>
          </div>
          <div>
            <small>音色</small>
            <strong>{currentVoice}</strong>
          </div>
          <div>
            <small>停顿</small>
            <strong>{config.pauseMs}ms</strong>
          </div>
        </div>

        {batchMetas.length ? (
          <div className="batchPlan">
            <div className="sectionHeaderCompact">
              <div>
                <h3>批次规划</h3>
                <p>生成和下载都会沿用这些批次名，方便之后查找。</p>
              </div>
              <span>{batchMetas.length} 个批次</span>
            </div>
            <div className="batchPlanGrid">
              {batchMetas.slice(0, 10).map((batch) => (
                <div className="batchChip" key={batch.fileStem} title={`${batch.firstWord} → ${batch.lastWord}`}>
                  <strong>B{pad3(batch.batchNo)}</strong>
                  <span>{batch.firstWord === batch.lastWord ? batch.firstWord : `${batch.firstWord} → ${batch.lastWord}`}</span>
                  <em>{batch.wordCount} 词</em>
                </div>
              ))}
              {batchMetas.length > 10 ? <div className="batchChip muted">+{batchMetas.length - 10} 个批次</div> : null}
            </div>
          </div>
        ) : null}

        <div className="audioGrid">
          <div className="audioList">
            <div className="sectionHeaderCompact">
              <div>
                <h3>在线播放试听</h3>
                <p>列表按批次显示，不再混成一串无意义文件。</p>
              </div>
              <span>{audioItems.length ? `${audioItems.length} 个批次` : '尚未生成'}</span>
            </div>
            {audioItems.length ? (
              <div className="compactAudioShell">
                {selectedAudioItem ? (
                  <div className="activeAudioPanel">
                    <div className="playerHero">
                      <div className="playerOrb">
                        <span>{pad3(selectedAudioItem.batchNo || safeSelectedAudioIndex + 1)}</span>
                      </div>
                      <div className="playerHeroCopy">
                        <small>当前批次</small>
                        <h3>{selectedAudioItem.firstWord === selectedAudioItem.lastWord ? selectedAudioItem.firstWord : `${selectedAudioItem.firstWord} → ${selectedAudioItem.lastWord}`}</h3>
                        <p>
                          {selectedAudioItem.subtitle || `${selectedAudioItem.words.length} 词`}
                          {selectedAudioItem.segments?.length
                            ? ` · Edge 分段 ${selectedAudioItem.segments.length} 个`
                            : ` · ${selectedAudioItem.provider === 'azure' ? 'Azure MP3' : 'MP3'}`}
                        </p>
                      </div>
                    </div>
                    <div className="playerMetaStrip">
                      <span>{config.accent === 'gb' ? '英音' : '美音'}</span>
                      <span>{currentVoice}</span>
                      <span>停顿 {selectedAudioItem.pauseMs ?? config.pauseMs}ms</span>
                    </div>
                    <WordSummary words={selectedWords} />
                    {selectedAudioItem.segments?.length ? (
                      <>
                        <SegmentedAudioPlayer item={selectedAudioItem} />
                      </>
                    ) : (
                      <>
                        <audio src={selectedAudioItem.url} controls preload="metadata" />
                        <div className="audioActionsRow">
                          <button
                            type="button"
                            onClick={() =>
                              downloadNamedBlob(
                                selectedAudioItem.blob,
                                `${selectedAudioItem.fileStem || `words-${safeSelectedAudioIndex + 1}`}.mp3`,
                              )
                            }
                          >
                            下载当前 MP3
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                <button className="playlistDockButton" type="button" onClick={openPlaylist} aria-expanded={playlistOpen}>
                  <span>播放列表</span>
                  <strong>
                    当前 {pad3(selectedAudioItem?.batchNo || safeSelectedAudioIndex + 1)} / {audioItems.length}
                  </strong>
                  <em>点击后向上展开，选择后自动收起</em>
                </button>
                {playlistOpen ? (
                  <div
                    className={playlistClosing ? 'inlinePlaylistLayer closing' : 'inlinePlaylistLayer'}
                    role="dialog"
                    aria-modal="true"
                    aria-label="播放列表"
                    onClick={closePlaylist}
                  >
                    <div className="inlinePlaylistSheet" onClick={(event) => event.stopPropagation()}>
                      <div className="playlistHandle" />
                      <div className="playlistHeader">
                        <div>
                          <span className="eyebrow">Playlist</span>
                          <h2>播放列表</h2>
                          <p>共 {audioItems.length} 个批次，点击批次即可切换当前播放器。</p>
                        </div>
                        <button type="button" onClick={closePlaylist}>
                          收起
                        </button>
                      </div>

                      <div className="playlistItems">
                        {audioItems.map((item, index) => (
                          <button
                            className={index === safeSelectedAudioIndex ? 'playlistItem active' : 'playlistItem'}
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setSelectedAudioIndex(index)
                              closePlaylist()
                            }}
                          >
                            <strong>{pad3(item.batchNo || index + 1)}</strong>
                            <span>{item.firstWord === item.lastWord ? item.firstWord : `${item.firstWord} → ${item.lastWord}`}</span>
                            <em>
                              {item.wordCount || item.words.length} 词
                              {item.segments?.length ? ` · ${item.segments.length} 段` : ''}
                            </em>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="emptyAudio">
                <Volume2 size={30} />
                <p>生成后会在这里出现音频播放器。首段试听适合快速校验音色、速度和停顿。</p>
              </div>
            )}
          </div>

        </div>
      </section>

      {libraryOpen ? (
        <div className="libraryOverlay" role="dialog" aria-modal="true" aria-label="管理已生成音频">
          <div className="libraryDrawer">
            <div className="libraryHeader">
              <div>
                <span className="eyebrow">Local Audio Library</span>
                <h2>管理已生成</h2>
                <p>音频保存在当前浏览器 IndexedDB 中，刷新页面后可从这里恢复播放和再次生成二维码。</p>
              </div>
              <button type="button" onClick={() => setLibraryOpen(false)}>
                关闭
              </button>
            </div>

            {libraryItems.length ? (
              <div className="libraryList">
                {libraryItems.map((item) => (
                  <div className={item.id === currentSessionId ? 'libraryItem active' : 'libraryItem'} key={item.id}>
                    <div>
                      <strong>{item.title || '单词朗读'}</strong>
                      <span>
                        {item.firstWord && item.lastWord ? `${item.firstWord} → ${item.lastWord} · ` : ''}
                        {item.totalWords || 0} 词 · {item.batchCount || item.itemCount || 0} 批次 · {item.provider === 'edge' ? 'Edge-TTS' : 'Azure'}
                      </span>
                      <small>
                        {new Date(item.createdAt || item.updatedAt || Date.now()).toLocaleString('zh-CN')}
                        {item.shareUrl ? ' · 已有手机播放链接' : ''}
                      </small>
                    </div>
                    <div className="libraryActions">
                      <button type="button" onClick={() => openLibrarySession(item.id)}>
                        恢复
                      </button>
                      {item.shareUrl ? (
                        <a href={item.shareUrl} target="_blank" rel="noreferrer">
                          打开链接
                        </a>
                      ) : null}
                      <button className="danger" type="button" onClick={() => removeLibrarySession(item.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="emptyLibrary">
                <Archive size={32} />
                <h3>暂无本地生成记录</h3>
                <p>点击“生成首段试听”或“批量生成音频”后，会自动保存到这里。</p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default TtsWorkspace
