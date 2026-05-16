import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import QRCode from 'qrcode'
import {
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
  chunkWords,
  downloadNamedBlob,
  getSpeechSupport,
  isEdgeBrowser,
  speakWordsLocally,
  splitWords,
  uniqueKeepOrder,
} from './ttsUtils'

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

const SelectField = ({ label, value, onChange, children }) => (
  <label className="field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  </label>
)

const NumberField = ({ label, value, onChange, min, max, suffix }) => (
  <label className="field">
    <span>{label}</span>
    <div className="inputShell">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clampInt(event.target.value, min, max, value))}
      />
      {suffix ? <em>{suffix}</em> : null}
    </div>
  </label>
)

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
  const [localSpeaking, setLocalSpeaking] = useState(false)
  const [localWord, setLocalWord] = useState('')
  const ttsFileRef = useRef(null)
  const stopLocalRef = useRef(null)

  const words = useMemo(() => uniqueKeepOrder(splitWords(wordText)), [wordText])
  const batches = useMemo(() => chunkWords(words, config.batchSize), [words, config.batchSize])
  const currentVoiceList = (voices[config.provider] || []).filter((voice) => voice.accent === config.accent)
  const currentVoice = config.provider === 'edge' ? config.edgeVoice : config.azureVoice
  const isEdge = isEdgeBrowser()

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
    if (!currentVoiceList.length) return
    const key = config.provider === 'edge' ? 'edgeVoice' : 'azureVoice'
    if (!currentVoiceList.some((voice) => voice.id === config[key])) {
      setConfig((current) => ({ ...current, [key]: currentVoiceList[0].id }))
    }
  }, [config.provider, config.accent, currentVoiceList])

  useEffect(() => () => stopLocalRef.current?.(), [])

  const updateTtsConfig = (patch) => setConfig((current) => ({ ...current, ...patch }))

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

  const generateBatch = async (batch, index) => {
    const blob = await fetchAudioBlob(getAudioEndpoint(config.provider), buildPayload(batch))
    return {
      id: `${Date.now()}-${index}`,
      blob,
      url: URL.createObjectURL(blob),
      words: batch,
      label: `第 ${index + 1} 段 · ${batch.length} 词`,
      provider: config.provider,
    }
  }

  const previewFirstBatch = async () => {
    if (!words.length) return setStatus('请先粘贴或导入单词。')
    setBusy(true)
    setStatus('正在生成首段试听音频…')
    try {
      const item = await generateBatch(batches[0], 0)
      setAudioItems((current) => [item, ...current])
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
    setStatus(`准备生成 ${batches.length} 段音频…`)
    const items = []
    try {
      for (let index = 0; index < batches.length; index += 1) {
        setStatus(`正在生成第 ${index + 1} / ${batches.length} 段…`)
        const item = await generateBatch(batches[index], index)
        items.push(item)
        setAudioItems([...items])
      }
      setStatus('全部音频已生成，可在线播放或生成手机二维码。')
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
    setStatus('正在创建 R2 分享并上传音频…')
    try {
      const start = await apiJson('/api/share/start', {
        method: 'POST',
        body: JSON.stringify({ count: audioItems.length }),
      })

      const tracks = []
      for (let index = 0; index < audioItems.length; index += 1) {
        const item = audioItems[index]
        setStatus(`正在上传第 ${index + 1} / ${audioItems.length} 段到 R2…`)
        const uploadResponse = await fetch(start.audio[index].uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'audio/mpeg' },
          body: item.blob,
        })
        if (!uploadResponse.ok) throw new Error(`R2 音频上传失败：${uploadResponse.status}`)
        tracks.push({
          key: start.audio[index].key,
          label: item.label,
          words: item.words,
          provider: item.provider,
        })
      }

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
        tracks,
      }

      const manifestResponse = await fetch(start.manifest.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(manifest),
      })
      if (!manifestResponse.ok) throw new Error(`R2 清单上传失败：${manifestResponse.status}`)

      await apiJson('/api/share/finalize', { method: 'POST', body: JSON.stringify({ shareId: start.shareId }) })

      const url = `${window.location.origin}/listen?token=${encodeURIComponent(start.token)}`
      const dataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1 })
      setShareUrl(url)
      setQrUrl(dataUrl)
      setStatus('二维码已生成，手机扫码即可播放。')
    } catch (error) {
      setStatus(error.message || '二维码生成失败。请检查 R2 环境变量和 CORS。')
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
          <button className="qrButton" type="button" onClick={createQrShare} disabled={busy || !audioItems.length}>
            <QrCode size={18} /> 生成手机二维码
          </button>
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

        <div className="audioGrid">
          <div className="audioList">
            <h3>在线播放试听</h3>
            {audioItems.length ? (
              audioItems.map((item, index) => (
                <div className="audioItem" key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.words.slice(0, 8).join(' · ')}</span>
                  </div>
                  <audio src={item.url} controls preload="metadata" />
                  <button type="button" onClick={() => downloadNamedBlob(item.blob, `words-${index + 1}.mp3`)}>
                    下载 MP3
                  </button>
                </div>
              ))
            ) : (
              <div className="emptyAudio">
                <Volume2 size={30} />
                <p>生成后会在这里出现音频播放器。首段试听适合快速校验音色、速度和停顿。</p>
              </div>
            )}
          </div>

          <div className="qrPanel">
            <h3>手机播放</h3>
            {qrUrl ? (
              <>
                <img src={qrUrl} alt="手机播放二维码" />
                <a href={shareUrl} target="_blank" rel="noreferrer">
                  打开播放链接
                </a>
                <p>二维码链接带只读签名 token，不需要手机再次输入密码。</p>
              </>
            ) : (
              <p>批量生成音频后，点击“生成手机二维码”上传到 R2 并创建移动播放页。</p>
            )}
          </div>
        </div>
      </section>
    </section>
  )
}

export default TtsWorkspace
