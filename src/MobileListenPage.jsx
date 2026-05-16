import React, { useEffect, useRef, useState } from 'react'
import { Headphones, Loader2, Pause, Play } from 'lucide-react'
import { apiJson } from './api'

function MobileListenPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manifest, setManifest] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef(null)

  const tracks = manifest?.tracks || []
  const currentTrack = tracks[currentIndex]

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (!token) {
      setError('播放链接缺少 token。')
      setLoading(false)
      return
    }

    apiJson(`/api/share?token=${encodeURIComponent(token)}`)
      .then((data) => setManifest(data.manifest))
      .catch((err) => setError(err.message || '读取播放清单失败。'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined
    const onEnded = () => {
      setPlaying(false)
      setCurrentIndex((index) => Math.min(tracks.length - 1, index + 1))
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
  }, [tracks.length])

  useEffect(() => {
    if (playing) audioRef.current?.play().catch(() => setPlaying(false))
  }, [currentIndex, playing])

  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    await audio.play()
    setPlaying(true)
  }

  if (loading) {
    return (
      <main className="mobileListen">
        <Loader2 className="spin" size={28} />
        <p>正在载入播放清单…</p>
      </main>
    )
  }

  if (error) {
    return (
      <main className="mobileListen">
        <Headphones size={34} />
        <h1>无法播放</h1>
        <p>{error}</p>
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
        </p>
      </div>

      <section className="mobilePlayer">
        <small>
          第 {currentIndex + 1} / {tracks.length} 段
        </small>
        <h2>{currentTrack?.label || '准备播放'}</h2>
        <audio ref={audioRef} src={currentTrack?.url || ''} preload="metadata" controls />
        <div className="mobileControls">
          <button type="button" onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))} disabled={currentIndex <= 0}>
            上一段
          </button>
          <button className="mobilePlay" type="button" onClick={togglePlay} disabled={!currentTrack}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
            {playing ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            onClick={() => setCurrentIndex((index) => Math.min(tracks.length - 1, index + 1))}
            disabled={currentIndex >= tracks.length - 1}
          >
            下一段
          </button>
        </div>
      </section>

      <section className="mobileList">
        {tracks.map((track, index) => (
          <button
            key={track.key || index}
            type="button"
            className={index === currentIndex ? 'active' : ''}
            onClick={() => setCurrentIndex(index)}
          >
            <span>{track.label || `第 ${index + 1} 段`}</span>
            <small>{track.words?.slice(0, 4).join(' · ')}</small>
          </button>
        ))}
      </section>
    </main>
  )
}

export default MobileListenPage
