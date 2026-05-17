import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Headphones, Link as LinkIcon, Loader2, Pause, Play, Save, Trash2 } from 'lucide-react'
import { apiJson } from './api'

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

const safeMp3Name = (value, fallback = 'audio') => {
  const name = safeFileName(value, fallback) || `${fallback}.mp3`
  return /\.mp3$/i.test(name) ? name : `${name}.mp3`
}

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
    </main>
  )
}

function DesktopSavedLibrary({ saved, onDelete }) {
  return (
    <main className="desktopListen">
      <section className="desktopListenHero">
        <div>
          <span>Saved Word Listen</span>
          <h1>{saved.length ? '已保存播放页' : '暂无保存的播放页'}</h1>
          <p>电脑端播放库使用更宽的列表视图；保存仍然只在当前浏览器本地有效。</p>
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

  if (loading) {
    return (
      <main className={mobileView ? 'mobileListen' : 'desktopListen'}>
        <Loader2 className="spin" size={28} />
        <p>正在载入播放清单…</p>
      </main>
    )
  }

  if (!token) {
    return mobileView ? <SavedLibrary saved={saved} onDelete={deleteSaved} /> : <DesktopSavedLibrary saved={saved} onDelete={deleteSaved} />
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
          <div className="desktopListenActions">
            <button type="button" onClick={() => persistCurrent()} disabled={savedCurrent}>
              <Save size={16} /> {savedCurrent ? '已保存' : '保存'}
            </button>
            <button type="button" onClick={copyLink}>
              <LinkIcon size={16} /> 复制链接
            </button>
            <a href="/listen">播放库</a>
          </div>
          {notice ? <small>{notice}</small> : null}
        </section>

        <section className="desktopListenGrid">
          <section className="desktopListenPlayer">
            <small>
              第 {currentIndex + 1} / {tracks.length} 段
            </small>
            <h2>{currentTrack?.batchTitle || currentBatch?.title || currentTrack?.label || '准备播放'}</h2>
            <p>
              {currentTrack?.label && currentTrack?.batchTitle !== currentTrack?.label ? `${currentTrack.label} · ` : ''}
              {currentTrack?.fileName || currentTrack?.batchLabel || ''}
            </p>
            <audio ref={audioRef} src={currentTrack?.url || ''} preload="metadata" controls />
            <div className="desktopListenControls">
              <button type="button" onClick={() => jumpTo(Math.max(0, currentIndex - 1))} disabled={currentIndex <= 0}>
                上一段
              </button>
              <button className="desktopListenPlay" type="button" onClick={togglePlay} disabled={!currentTrack}>
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
              <button className="desktopDownload" type="button" onClick={() => downloadUrl(currentTrack.url, safeMp3Name(currentTrack.fileName || currentTrack.label))}>
                <Download size={16} /> 下载当前音频
              </button>
            ) : null}
          </section>

          <aside className="desktopListenList">
            <div className="desktopListHeader">
              <h3>播放列表</h3>
              <span>{groupedTracks.length} 个批次</span>
            </div>
            {groupedTracks.map((group) => (
              <div className="desktopListenBatch" key={group.key}>
                <strong>{group.title}</strong>
                <small>
                  {group.subtitle}
                  {group.batchLabel ? ` · ${group.batchLabel}` : ''}
                </small>
                {group.tracks.map(({ track, index }) => (
                  <button className={index === currentIndex ? 'desktopListenTrack active' : 'desktopListenTrack'} key={track.key || index} type="button" onClick={() => jumpTo(index)}>
                    <span>{track.label || `第 ${index + 1} 段`}</span>
                    <em>
                      {track.words?.slice(0, 5).join(' · ')}
                      {track.words?.length > 5 ? ` · +${track.words.length - 5}` : ''}
                    </em>
                  </button>
                ))}
              </div>
            ))}
          </aside>
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
        <h2>{currentTrack?.batchTitle || currentTrack?.label || '准备播放'}</h2>
        {currentTrack ? (
          <p className="mobileTrackMeta">
            {currentTrack.batchTitle && currentTrack.label !== currentTrack.batchTitle ? `${currentTrack.label} · ` : ''}
            {currentTrack.fileName || currentTrack.batchLabel || ''}
          </p>
        ) : null}
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
            onClick={() => downloadUrl(currentTrack.url, safeMp3Name(currentTrack.fileName || currentTrack.label))}
          >
            <Download size={16} /> 下载当前音频
          </button>
        ) : null}
      </section>

      <section className="mobileList">
        {groupedTracks.map((group) => (
          <div className="mobileBatch" key={group.key}>
            <div className="mobileBatchHeader">
              <strong>{group.title}</strong>
              <small>
                {group.subtitle}
                {group.batchLabel ? ` · ${group.batchLabel}` : ''}
              </small>
            </div>
            {group.tracks.map(({ track, index }) => (
              <div className={index === currentIndex ? 'mobileTrack active' : 'mobileTrack'} key={track.key || index}>
                <button type="button" onClick={() => jumpTo(index)}>
                  <span>{track.label || `第 ${index + 1} 段`}</span>
                  <small>
                    {track.words?.slice(0, 4).join(' · ')}
                    {track.delayAfterMs ? ` · 后停顿 ${track.delayAfterMs}ms` : ''}
                    {track.fileName ? ` · ${track.fileName}` : ''}
                  </small>
                </button>
                <button type="button" onClick={() => downloadUrl(track.url, safeMp3Name(track.fileName || track.label))}>
                  <Download size={15} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </section>
    </main>
  )
}

export default MobileListenPage
