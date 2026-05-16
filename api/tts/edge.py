import base64
import asyncio
import hashlib
import hmac
import json
import os
import tempfile
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
import edge_tts

SESSION_COOKIE = 'tts_session'


def _send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('content-type', 'application/json; charset=utf-8')
    handler.send_header('content-length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler):
    length = int(handler.headers.get('content-length') or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode('utf-8')
    return json.loads(raw or '{}')


def _b64url_digest(data, secret):
    digest = hmac.new(secret.encode('utf-8'), data.encode('utf-8'), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode('utf-8').rstrip('=')


def _has_session(handler):
    secret = os.environ.get('TTS_SESSION_SECRET')
    if not secret:
        return False

    cookie = SimpleCookie()
    cookie.load(handler.headers.get('cookie') or '')
    morsel = cookie.get(SESSION_COOKIE)
    if not morsel:
        return False

    parts = morsel.value.split('.')
    if len(parts) != 3:
        return False

    expires_at, nonce, signature = parts
    payload = f'{expires_at}.{nonce}'
    try:
        if float(expires_at) < time.time() * 1000:
            return False
    except ValueError:
        return False

    return hmac.compare_digest(signature, _b64url_digest(payload, secret))


async def _save_edge_audio(text, voice, rate_text, output_path):
    communicate = edge_tts.Communicate(text, voice, rate=rate_text)
    await communicate.save(output_path)


def _edge_tts(handler):
    if not _has_session(handler):
        _send_json(handler, HTTPStatus.UNAUTHORIZED, {'ok': False, 'error': '请先输入访问密码。'})
        return

    try:
        body = _read_body(handler)
        words = [str(word).strip() for word in body.get('words', []) if str(word).strip()][:80]
        if not words:
            _send_json(handler, HTTPStatus.BAD_REQUEST, {'ok': False, 'error': '没有可朗读的单词。'})
            return

        accent = body.get('accent')
        voice = body.get('voice') or ('en-GB-SoniaNeural' if accent == 'gb' else 'en-US-JennyNeural')
        rate = float(body.get('rate') or 0)
        pause_ms = int(float(body.get('pauseMs') or 800))
        text = (' ' * max(1, min(20, round(pause_ms / 120)))).join(words)
        rate_text = f'{rate:+.0f}%'

        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp3') as fp:
            output_path = fp.name

        try:
            asyncio.run(_save_edge_audio(text, voice, rate_text, output_path))
            with open(output_path, 'rb') as audio_file:
                audio = audio_file.read()
        finally:
            try:
                os.remove(output_path)
            except OSError:
                pass

        handler.send_response(HTTPStatus.OK)
        handler.send_header('content-type', 'audio/mpeg')
        handler.send_header('cache-control', 'no-store')
        handler.send_header('x-tts-provider', 'edge')
        handler.send_header('content-length', str(len(audio)))
        handler.end_headers()
        handler.wfile.write(audio)
    except Exception as exc:
        _send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {'ok': False, 'error': str(exc) or 'Edge-TTS 生成失败。'})


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        _edge_tts(self)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header('access-control-allow-methods', 'POST, OPTIONS')
        self.send_header('access-control-allow-headers', 'content-type')
        self.end_headers()
