import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Headphones, Link as LinkIcon, Loader2, Pause, Play, Save, Trash2 } from 'lucide-react'
import { apiJson } from './api'

const SAVED_KEY = 'xlsx2pdf_tts_saved_shares'

const getTokenFromLocation = () => new URLSearchParams(window.location.search).get('token') || ''

const readSavedShares = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeSavedShares = (items) => {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(items.slice(0, 50)))
    return true
  } catch {
    return false
  }
}

const downloadUrl = (url, name = 'audio.mp3') => {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.target = '_blank'
  anchor.rel = 'noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

const safeFileName = (value, fallback = 'audio') => String(value || fallback)
  .replace(/[\\/:*?"<>|]+/g, '-')
  .replace(/\s+/g, '-')
  .slice(0, 80)

function SavedLibrary({ saved, onDelete }) {
  if (!saved.length) {
    return (
      <main className="mobileListen">
        <div className="mobileHero">
          <Headphones size={36} />
          <span>Saved Word Listen</span>
          <h1>暂无保存的播放页</h1>
          <p>打开任意二维码播放链接后，点击“保存到此设备”，之后可从这个页面继续播放。</p>
        </div>
      </main>
    )
  }

  return (
    <main className="mobileListen">
      <div className="mobileHero">
        <Headphones size={36} />
        <span>Saved Word Listen</span>
        <h1>已保存播放页</h1>
        <p>保存在当前浏览器本地；换设备或清理浏览器数据后需要重新扫码。</p>
      </div>
      <section className="mobileList">
        {saved.map((item) => (
          <div className="savedShare" key={item.token}>
            <a href={`/listen?token=${encodeURIComponent(item.token)}`}>
              <strong>{item.title || '单词朗读'}</strong>
              <small>
                {item.totalWords || 0} 个单词 · {item.trackCount || 0} 段 · 保存于 {new Date(item.savedAt).toLocaleDateString('zh-CN')}
              </small>
            </a>
            <button type="button" onClick={() => onDelete(item.token)} aria-label="删除保存">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </section>
    </main>
  )
}

function MobileListenPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manifest, setManifest] = useState(null)
  const [expiresAt, setExpiresAt] = useState(null)
  const [saved, setSaved] = useState(() => readSavedShares())
  const [currentIndex, setCurrentIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState('')
  const audioRef = useRef(null)
  const timerRef = useRef(null)

  const token = useMemo(() => getTokenFromLocation(), [])
  const tracks = manifest?.tracks || []
  const currentTrack = tracks[currentIndex]
  const savedCurrent = token && saved.some((item) => item.token === token)

  const persistCurrent = (loadedManifest = manifest, loadedExpiresAt = expiresAt) => {
    if (!token || !loadedManifest) return
    const nextItem = {
      token,
      title: loadedManifest.title || '单词朗读',
      totalWords: loadedManifest.totalWords || 0,
      trackCount: loadedManifest.tracks?.length || 0,
      expiresAt: loadedExpiresAt || loadedManifest.expiresAt || null,
      savedAt: Date.now(),
    }
    const next = [nextItem, ...readSavedShares().filter((item) => item.token !== token)]
    if (writeSavedShares(next)) {
      setSaved(next)
      setNotice('已保存到此设备。')
    } else {
      setNotice('当前浏览器无法写入本地保存。')
    }
  }

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }

    apiJson(`/api/share?token=${encodeURIComponent(token)}`)
      .then((data) => {
        setManifest(data.manifest)
        setExpiresAt(data.expiresAt)
        // 自动保存最近打开的长期链接，避免扫码后找不到。
        persistCurrent(data.manifest, data.expiresAt)
      })
      .catch((err) => setError(err.message || '读取播放清单失败。'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined
    const onEnded = () => {
      if (currentIndex >= tracks.length - 1) {
        setPlaying(false)
        return
      }
      timerRef.current = window.setTimeout(() => {
        setCurrentIndex((index) => Math.min(tracks.length - 1, index + 1))
      }, currentTrack?.delayAfterMs || 0)
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
  }, [currentIndex, currentTrack?.delayAfterMs, tracks.length])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  useEffect(() => {
    if (playing) audioRef.current?.play().catch(() => setPlaying(false))
  }, [currentIndex, playing])

  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      window.clearTimeout(timerRef.current)
      audio.pause()
      setPlaying(false)
      return
    }
    await audio.play()
    setPlaying(true)
  }

  const jumpTo = (nextIndex) => {
    window.clearTimeout(timerRef.current)
    setCurrentIndex(nextIndex)
  }

  const deleteSaved = (deleteToken) => {
    const next = saved.filter((item) => item.token !== deleteToken)
    if (writeSavedShares(next)) setSaved(next)
  }

  const copyLink = async () => {
    const url = `${window.location.origin}/listen?token=${encodeURIComponent(token)}`
    await navigator.clipboard?.writeText(url)
    setNotice('播放链接已复制。')
  }

  if (loading) {
    return (
      <main className="mobileListen">
        <Loader2 className="spin" size={28} />
        <p>正在载入播放清单…</p>
      </main>
    )
  }

  if (!token) return <SavedLibrary saved={saved} onDelete={deleteSaved} />

  if (error) {
    return (
      <main className="mobileListen">
        <Headphones size={34} />
        <h1>无法播放</h1>
        <p>{error}</p>
        {saved.length ? <a className="mobileLinkButton" href="/listen">查看已保存播放页</a> : null}
      </main>
    )
  }

  return (
    <main className="mobileListen">
      <div className="mobileHero">
        <Headphones size={36} />
        <span>Word Listen</span>
        <h1>{manifest?.title || '单词朗读'}</h1>
        <p>
          共 {manifest?.totalWords || 0} 个单词 · {tracks.length} 段音频
          {expiresAt ? ` · 链接有效至 ${new Date(expiresAt).toLocaleDateString('zh-CN')}` : ''}
        </p>
      </div>

      <section className="mobileSaveBar">
        <button type="button" onClick={() => persistCurrent()} disabled={savedCurrent}>
          <Save size={16} /> {savedCurrent ? '已保存到此设备' : '保存到此设备'}
        </button>
        <button type="button" onClick={copyLink}>
          <LinkIcon size={16} /> 复制长期链接
        </button>
        <a href="/listen">播放库</a>
        {notice ? <small>{notice}</small> : null}
      </section>

      <section className="mobilePlayer">
        <small>
          第 {currentIndex + 1} / {tracks.length} 段
        </small>
        <h2>{currentTrack?.label || '准备播放'}</h2>
        <audio ref={audioRef} src={currentTrack?.url || ''} preload="metadata" controls />
        <div className="mobileControls">
          <button type="button" onClick={() => jumpTo(Math.max(0, currentIndex - 1))} disabled={currentIndex <= 0}>
            上一段
          </button>
          <button className="mobilePlay" type="button" onClick={togglePlay} disabled={!currentTrack}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
            {playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            onClick={() => jumpTo(Math.min(tracks.length - 1, currentIndex + 1))}
            disabled={currentIndex >= tracks.length - 1}
          >
            下一段
          </button>
        </div>
        {currentTrack?.url ? (
          <button
            className="mobileDownload"
            type="button"
            onClick={() => downloadUrl(currentTrack.url, `${safeFileName(currentTrack.fileName || currentTrack.label)}.mp3`)}
          >
            <Download size={16} /> 下载当前音频
          </button>
        ) : null}
      </section>

      <section className="mobileList">
        {tracks.map((track, index) => (
          <div className={index === currentIndex ? 'mobileTrack active' : 'mobileTrack'} key={track.key || index}>
            <button type="button" onClick={() => jumpTo(index)}>
              <span>{track.label || `第 ${index + 1} 段`}</span>
              <small>
                {track.words?.slice(0, 4).join(' · ')}
                {track.delayAfterMs ? ` · 后停顿 ${track.delayAfterMs}ms` : ''}
              </small>
            </button>
            <button type="button" onClick={() => downloadUrl(track.url, `${safeFileName(track.fileName || track.label)}.mp3`)}>
              <Download size={15} />
            </button>
          </div>
        ))}
      </section>
    </main>
  )
}

export default MobileListenPage
