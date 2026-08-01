import React, { useState } from 'react'
import { Loader2, Lock } from 'lucide-react'

let authGateId = 0

// 受保护板块共用的密码解锁卡片。onSubmit(password) 应返回 Promise，
// reject 时展示 error.message；resolve 后由父组件切换登录态。
function AuthGate({ eyebrow, title, description, onSubmit }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [inputId] = useState(() => `gate-password-${(authGateId += 1)}`)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      await onSubmit(password)
      setPassword('')
    } catch (err) {
      setError(err.message || '登录失败。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="ttsGate">
      <div className="gateCard">
        <Lock size={34} />
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
        <form onSubmit={handleSubmit}>
          <label className="gatePasswordLabel" htmlFor={inputId}>
            访问密码
          </label>
          <input
            id={inputId}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入访问密码"
            autoComplete="current-password"
          />
          <button className="primaryButton dark" type="submit" disabled={submitting}>
            {submitting ? <Loader2 className="spin" size={18} /> : null}
            解锁
          </button>
        </form>
        {error ? <strong className="errorText">{error}</strong> : null}
      </div>
    </section>
  )
}

export default AuthGate
