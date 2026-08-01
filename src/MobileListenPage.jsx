import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Headphones, Link as LinkIcon, Loader2, Pause, Play, Save, Trash2 } from 'lucide-react'
import { apiJson } from './api'
import { downloadNamedBlob } from './ttsUtils'

const SAVED_KEY = 'xlsx2pdf_tts_saved_shares'

const getTokenFromLocation = () => new URLSearchParams(window.location.search).get('token') || ''

const isMobileViewport = () => {
  if (typeof window === 'undefined') return true
  return window.matchMedia('(max-width: 760px), (pointer: coarse)').matches
}

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

const downloadUrl = async (url, name = 'audio.mp3') => {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    downloadNamedBlob(blob, name)
    return true
  } catch {
    // 跨域受限时回退：在新标签打开音频。
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    return false
  }
}

const safeFileName = (value, fallback = 'audio') => String(value || fallback)
  .replace(/[\\/:*?"<>|]+/g, '-')
  .replace(/\s+/g, '-')
  .slice(0, 80)

const safeMp3Name = (value, fallback = 'audio') => {
  const name = safeFileName(value, fallback) || `${fallback}.mp3`
  return /\.mp3$/i.test(name) ? name : `${name}.mp3`
}

const batchLabel = (group) =>
  `${group.subtitle}${group.batchLabel ? ` · ${group.batchLabel}` : ''}`

const trackWordsText = (track, max) => {
  const head = track.words?.slice(0, max).join(' · ')
  return track.words?.length > max ? `${head} · +${track.words.length - max}` : head || ''
}

// ── Shared presentational pieces (desktop / mobile share the same controls) ──

function PlaybackControls({ variant, currentIndex, total, playing, onPrev, onToggle, onNext, canPlay }) {
  const root = variant === 'desktop' ? 'desktopListenControls' : 'mobileControls'
  const playClass = variant === 'desktop' ? 'desktopListenPlay' : 'mobilePlay'
  return (
    <div className={root}>
      <button type="button" onClick={onPrev} disabled={currentIndex <= 0}>
        上一段
      </button>
      <button className={playClass} type="button" onClick={onToggle} disabled={!canPlay}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
        {playing ? '暂停' : '播放'}
      </button>
      <button type="button" onClick={onNext} disabled={currentIndex >= total - 1}>
        下一段
      </button>
    </div>
  )
}

function SaveActions({ variant, savedCurrent, onSave, onCopyLink, notice }) {
  const root = variant === 'desktop' ? 'desktopListenActions' : 'mobileSaveBar'
  return (
    <div className={root}>
      <button type="button" onClick={onSave} disabled={savedCurrent}>
        <Save size={16} /> {savedCurrent ? '已保存' : '保存'}
      </button>
      <button type="button" onClick={onCopyLink}>
        <LinkIcon size={16} /> 复制长期链接
      </button>
      <a href="/listen">播放库</a>
      {notice ? <small>{notice}</small> : null}
    </div>
  )
}

function PlayerPane({
  variant,
  audioRef,
  currentIndex,
  total,
  currentTrack,
  currentBatch,
  playing,
  onPrev,
  onToggle,
  onNext,
  onDownload,
}) {
  const root = variant === 'desktop' ? 'desktopListenPlayer' : 'mobilePlayer'
  const downloadClass = variant === 'desktop' ? 'desktopDownload' : 'mobileDownload'
  const metaClass = variant === 'mobile' ? 'mobileTrackMeta' : ''
  return (
    <section className={root}>
      <small>
        第 {currentIndex + 1} / {total} 段
      </small>
      <h2>{currentTrack?.batchTitle || currentBatch?.title || currentTrack?.label || '准备播放'}</h2>
      {currentTrack ? (
        <p className={metaClass}>
          {currentTrack.batchTitle && currentTrack.label !== currentTrack.batchTitle ? `${currentTrack.label} · ` : ''}
          {currentTrack.fileName || currentTrack.batchLabel || ''}
        </p>
      ) : null}
      <audio ref={audioRef} src={currentTrack?.url || ''} preload="metadata" controls />
      <PlaybackControls
        variant={variant}
        currentIndex={currentIndex}
        total={total}
        playing={playing}
        onPrev={onPrev}
        onToggle={onToggle}
        onNext={onNext}
        canPlay={Boolean(currentTrack)}
      />
      {currentTrack?.url ? (
        <button className={downloadClass} type="button" onClick={onDownload}>
          <Download size={16} /> 下载当前音频
        </button>
      ) : null}
    </section>
  )
}

function BatchList({ variant, groupedTracks, currentIndex, onJump, onDownload }) {
  const root = variant === 'desktop' ? 'desktopListenList' : 'mobileList'
  const batchClass = variant === 'desktop' ? 'desktopListenBatch' : 'mobileBatch'
  const trackClass = variant === 'desktop' ? 'desktopListenTrack' : 'mobileTrack'
  return (
    <div className={root}>
      {variant === 'desktop' ? (
        <div className="desktopListHeader">
          <h3>播放列表</h3>
          <span>{groupedTracks.length} 个批次</span>
        </div>
      ) : null}
      {groupedTracks.map((group) => (
        <div className={batchClass} key={group.key}>
          {variant === 'desktop' ? (
            <>
              <strong>{group.title}</strong>
              <small>{batchLabel(group)}</small>
            </>
          ) : (
            <div className="mobileBatchHeader">
              <strong>{group.title}</strong>
              <small>{batchLabel(group)}</small>
            </div>
          )}
          {group.tracks.map(({ track, index }) => (
            <div className={index === currentIndex ? `${trackClass} active` : trackClass} key={track.key || index}>
              <button type="button" onClick={() => onJump(index)}>
                <span>{track.label || `第 ${index + 1} 段`}</span>
                {variant === 'desktop' ? (
                  <em>{trackWordsText(track, 5)}</em>
                ) : (
                  <small>
                    {trackWordsText(track, 4)}
                    {track.delayAfterMs ? ` · 后停顿 ${track.delayAfterMs}ms` : ''}
                    {track.fileName ? ` · ${track.fileName}` : ''}
                  </small>
                )}
              </button>
              {variant === 'mobile' ? (
                <button
                  type="button"
                  onClick={() => onDownload(track)}
                  aria-label={`下载 ${track.label || `第 ${index + 1} 段`}`}
                >
                  <Download size={15} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SavedLibraryView({ mobile, saved, onDelete }) {
  const emptyCopy = {
    title: saved.length ? '已保存播放页' : '暂无保存的播放页',
    description: saved.length
      ? '保存在当前浏览器本地；换设备或清理浏览器数据后需要重新扫码。'
      : '打开任意二维码播放链接后，点击“保存到此设备”，之后可从这个页面继续播放。',
  }

  if (mobile) {
    return (
      <main className="mobileListen">
        <div className="mobileHero">
          <Headphones size={36} />
          <span>Saved Word Listen</span>
          <h1>{emptyCopy.title}</h1>
          <p>{emptyCopy.description}</p>
        </div>
        {saved.length ? (
          <section className="mobileList">
            {saved.map((item) => (
              <div className="savedShare" key={item.token}>
                <a href={`/listen?token=${encodeURIComponent(item.token)}`}>
                  <strong>{item.title || '单词朗读'}</strong>
                  {item.summary ? <small className="savedSummary">{item.summary}</small> : null}
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
        ) : null}
      </main>
    )
  }

  return (
    <main className="desktopListen">
      <section className="desktopListenHero">
        <div>
          <span>Saved Word Listen</span>
          <h1>{emptyCopy.title}</h1>
          <p>{emptyCopy.description}</p>
        </div>
      </section>

      <section className="desktopSavedGrid">
        {saved.length ? (
          saved.map((item) => (
            <div className="desktopSavedItem" key={item.token}>
              <a href={`/listen?token=${encodeURIComponent(item.token)}`}>
                <strong>{item.title || '单词朗读'}</strong>
                {item.summary ? <span>{item.summary}</span> : null}
                <small>
                  {item.totalWords || 0} 个单词 · {item.trackCount || 0} 段 · 保存于 {new Date(item.savedAt).toLocaleDateString('zh-CN')}
                </small>
              </a>
              <button type="button" onClick={() => onDelete(item.token)} aria-label="删除保存">
                <Trash2 size={16} /> 删除
              </button>
            </div>
          ))
        ) : (
          <div className="desktopEmptyListen">
            <Headphones size={38} />
            <h2>扫码或打开一个播放链接后会出现在这里</h2>
          </div>
        )}
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
  const [mobileView, setMobileView] = useState(() => isMobileViewport())
  const audioRef = useRef(null)
  const timerRef = useRef(null)

  const token = useMemo(() => getTokenFromLocation(), [])
  const tracks = manifest?.tracks || []
  const currentTrack = tracks[currentIndex]
  const savedCurrent = token && saved.some((item) => item.token === token)
  const groupedTracks = useMemo(() => {
    const manifestBatches = manifest?.batches || []
    const batchBySource = new Map(manifestBatches.map((batch) => [String(batch.sourceIndex), batch]))
    const batchByLabel = new Map(manifestBatches.filter((batch) => batch.batchLabel).map((batch) => [batch.batchLabel, batch]))
    const groups = []
    const groupMap = new Map()

    tracks.forEach((track, index) => {
      const meta = batchBySource.get(String(track.sourceIndex)) || batchByLabel.get(track.batchLabel)
      const key = String(track.sourceIndex ?? track.batchLabel ?? track.folder ?? index)
      let group = groupMap.get(key)
      if (!group) {
        group = {
          key,
          title: track.batchTitle || meta?.title || track.batchLabel || `第 ${groups.length + 1} 批`,
          subtitle: track.batchSubtitle || meta?.subtitle || `${meta?.wordCount || track.words?.length || 1} 词`,
          batchLabel: track.batchLabel || meta?.batchLabel || '',
          tracks: [],
        }
        groupMap.set(key, group)
        groups.push(group)
      }
      group.tracks.push({ track, index })
    })

    return groups
  }, [manifest, tracks])
  const currentBatch = currentTrack
    ? groupedTracks.find((group) => group.tracks.some((entry) => entry.index === currentIndex))
    : null

  const persistCurrent = (loadedManifest = manifest, loadedExpiresAt = expiresAt) => {
    if (!token || !loadedManifest) return
    const summary = (loadedManifest.batches || [])
      .slice(0, 2)
      .map((batch) => batch.title || batch.batchLabel)
      .filter(Boolean)
      .join(' / ')
    const nextItem = {
      token,
      title: loadedManifest.title || '单词朗读',
      summary: summary || loadedManifest.tracks?.[0]?.label || '',
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
    const update = () => setMobileView(isMobileViewport())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

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

  const downloadTrack = async (track) => {
    const ok = await downloadUrl(track.url, safeMp3Name(track.fileName || track.label))
    if (!ok) setNotice('音频下载失败，已在新标签页打开。')
  }

  if (loading) {
    return (
      <main className={mobileView ? 'mobileListen' : 'desktopListen'}>
        <Loader2 className="spin" size={28} />
        <p>正在载入播放清单…</p>
      </main>
    )
  }

  if (!token) {
    return <SavedLibraryView mobile={mobileView} saved={saved} onDelete={deleteSaved} />
  }

  if (error) {
    return (
      <main className={mobileView ? 'mobileListen' : 'desktopListen'}>
        <Headphones size={34} />
        <h1>无法播放</h1>
        <p>{error}</p>
        {saved.length ? <a className="mobileLinkButton" href="/listen">查看已保存播放页</a> : null}
      </main>
    )
  }

  const playerProps = {
    variant: mobileView ? 'mobile' : 'desktop',
    audioRef,
    currentIndex,
    total: tracks.length,
    currentTrack,
    currentBatch,
    playing,
    onPrev: () => jumpTo(Math.max(0, currentIndex - 1)),
    onToggle: togglePlay,
    onNext: () => jumpTo(Math.min(tracks.length - 1, currentIndex + 1)),
    onDownload: () => currentTrack && downloadTrack(currentTrack),
  }

  if (!mobileView) {
    return (
      <main className="desktopListen">
        <section className="desktopListenHero">
          <div>
            <span>Desktop Word Listen</span>
            <h1>{manifest?.title || '单词朗读'}</h1>
            <p>
              共 {manifest?.totalWords || 0} 个单词 · {tracks.length} 段音频
              {expiresAt ? ` · 链接有效至 ${new Date(expiresAt).toLocaleDateString('zh-CN')}` : ''}
            </p>
          </div>
          <SaveActions
            variant="desktop"
            savedCurrent={savedCurrent}
            onSave={() => persistCurrent()}
            onCopyLink={copyLink}
            notice={notice}
          />
        </section>

        <section className="desktopListenGrid">
          <PlayerPane {...playerProps} />
          <BatchList
            variant="desktop"
            groupedTracks={groupedTracks}
            currentIndex={currentIndex}
            onJump={jumpTo}
            onDownload={downloadTrack}
          />
        </section>
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

      <SaveActions
        variant="mobile"
        savedCurrent={savedCurrent}
        onSave={() => persistCurrent()}
        onCopyLink={copyLink}
        notice={notice}
      />

      <PlayerPane {...playerProps} />

      <BatchList
        variant="mobile"
        groupedTracks={groupedTracks}
        currentIndex={currentIndex}
        onJump={jumpTo}
        onDownload={downloadTrack}
      />
    </main>
  )
}

export default MobileListenPage
