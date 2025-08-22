const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');

// TTS/STT는 ElevenLabs 사용 (VOICE_ID_DEFAULT 고정)
const { textToSpeech, speechToText } = require('../services/elevenlabs');

const upload = multer();

/* ================== ENV ================== */
let { DIFY_API_URL, DIFY_API_KEY } = process.env;

if (!DIFY_API_URL) console.warn('[chatbot] DIFY_API_URL is not set');
if (!DIFY_API_KEY) console.warn('[chatbot] DIFY_API_KEY (chat app key) is not set');

if (typeof DIFY_API_URL === 'string') {
  DIFY_API_URL = DIFY_API_URL.replace(/\/+$/, ''); // remove trailing slash
}

const authHeaders = () => ({
  Authorization: `Bearer ${DIFY_API_KEY}`,
  'Content-Type': 'application/json',
});

/* ================== /chat 프리핸들러(정규식) ================== */
router.all(/^\/chat\/?$/, (_req, _res, next) => next());

/* ================== [C] 챗봇 대화 (Chat App: /chat-messages) ================== */
router.post('/chat', async (req, res) => {
  // message, query 둘 다 수용
  const message = (req.body?.message ?? req.body?.query ?? '').toString();
  const inputs = req.body?.inputs || {};
  const user = (req.body?.user || 'chatbot').toString();
  const stream = req.body?.stream !== undefined ? !!req.body.stream : true;

  // Chat App은 query(=message)가 반드시 필요
  if (!message.trim()) {
    return res.status(422).json({ error: 'message(또는 query) is required for chat app' });
  }

  if (!DIFY_API_URL || !DIFY_API_KEY) {
    return res.status(503).json({
      error: 'service_unavailable',
      detail: 'DIFY_API_URL / DIFY_API_KEY 설정이 없습니다.',
    });
  }

  // ---------- 블로킹 ----------
  if (!stream) {
    try {
      const { data } = await axios.post(
        `${DIFY_API_URL}/chat-messages`,
        { query: message, inputs, response_mode: 'blocking', user },
        { headers: authHeaders(), timeout: 60_000 }
      );
      return res.json({ answer: data?.answer ?? '' });
    } catch (err) {
      const detail = err?.response?.data || err?.message || String(err);
      console.error('[Dify blocking] error:', detail);
      if (err?.response?.status === 400 && err?.response?.data?.code === 'not_chat_app') {
        return res.status(400).json({
          error: 'not_chat_app',
          detail:
            '현재 키가 Chatflow(Workflow) 앱용입니다. Chatflow는 /workflows/run 엔드포인트를 사용하세요.',
        });
      }
      return res.status(500).json({ error: 'Dify 호출 실패', detail });
    }
  }

  // ---------- 스트리밍 (SSE) ----------
  let upstream;
  try {
    upstream = await axios({
      method: 'POST',
      url: `${DIFY_API_URL}/chat-messages`,
      headers: authHeaders(),
      data: { query: message, inputs, response_mode: 'streaming', user },
      responseType: 'stream',
      timeout: 120_000,
    });

    // SSE 헤더
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let closed = false;
    req.on('close', () => {
      closed = true;
      try {
        upstream?.data?.destroy?.();
      } catch (_) {}
    });

    upstream.data.on('data', (chunk) => {
      if (closed) return;
      const lines = chunk.toString().split('\n').filter((l) => l.startsWith('data:'));
      for (const line of lines) {
        const jsonPart = line.replace(/^data:\s*/, '');
        res.write(`data: ${jsonPart}\n\n`);
      }
    });

    upstream.data.on('end', () => {
      if (closed) return;
      res.write('data: [DONE]\n\n');
      res.end();
    });

    upstream.data.on('error', (err) => {
      console.error('[Dify stream] error event:', err?.message || err);
      if (!closed) {
        try {
          res.write(
            `data: ${JSON.stringify({
              error: 'stream_error',
              detail: err?.message || String(err),
            })}\n\n`
          );
        } catch (_) {}
        res.end();
      }
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error('[Dify stream create] error:', detail);
    if (err?.response?.status === 400 && err?.response?.data?.code === 'not_chat_app') {
      return res.status(400).json({
        error: 'not_chat_app',
        detail:
          '현재 키가 Chatflow(Workflow) 앱용입니다. Chatflow는 /workflows/run 엔드포인트를 사용하세요.',
      });
    }
    return res.status(500).json({ error: 'Dify API 호출 실패', detail });
  }
});

/* ================== Health & Ping ================== */
router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'chatbot-root', ts: Date.now() });
});
router.get('/health', (_req, res) => {
  res.json({ ok: true, via: 'chatbot.js', ts: Date.now() });
});
router.get('/chat', (_req, res) => {
  res.json({ ok: true, service: 'chatbot-chat-root', ts: Date.now() });
});

/* ================== [A] 음성 → 텍스트 (STT) ================== */
router.post('/stt', upload.single('file'), async (req, res) => {
  try {
    const { buffer, originalname, mimetype } = req.file || {};
    if (!buffer) return res.status(400).json({ error: '파일이 없습니다.' });

    const text = await speechToText(
      buffer,
      originalname || 'audio.webm',
      mimetype || 'audio/webm'
    );
    res.json({ text });
  } catch (err) {
    console.error('[STT] error:', err?.message || err);
    res.status(500).json({ error: 'STT 실패', detail: err?.message || String(err) });
  }
});

/* ================== [B] 텍스트 → 음성 (TTS) ================== */
router.post('/tts', upload.none(), async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(422).json({ error: 'text는 필수입니다.' });

    // 챗봇 보이스는 항상 DEFAULT → VOICE_ID_DEFAULT 사용
    const audioBuffer = await textToSpeech(text, 'DEFAULT');

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'inline; filename="speech.mp3"',
    });
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('[TTS] error:', err?.message || err);
    res.status(500).json({ error: 'TTS 실패', detail: err?.message || String(err) });
  }
});

/* ================== 라우터 로컬 404 ================== */
router.use((req, res) => {
  console.warn(
    '[chatbot-router] 404',
    req.method,
    req.originalUrl,
    'baseUrl=',
    req.baseUrl,
    'path=',
    req.path
  );
  res.status(404).json({ error: 'chatbot_not_found', path: req.originalUrl });
});

module.exports = router;
