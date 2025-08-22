const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const cors = require('cors');
const morgan = require('morgan');

// .env 로드 (프로젝트 루트 기준)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();

/* ===================== 기본 미들웨어 ===================== */
app.disable('x-powered-by');
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* ===================== CORS ===================== */
const DEFAULT_ORIGINS = [
  'http://localhost:8501',
  'http://127.0.0.1:8501',
  'https://jobverse.site',
];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // 서버-서버/로컬 curl 허용
    cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Range', 'Origin'],
  exposedHeaders: ['interviewer', 'X-Interview-Ended', 'X-Next-Cursor'],
  optionsSuccessStatus: 204,
  preflightContinue: false,
};
app.use(cors(corsOptions));
// '*' 대신 정규식으로 — 일부 환경에서 path-to-regexp 문제 방지
app.options(/.*/, cors(corsOptions));

/* 프록시 신뢰 설정 */
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

/* 커스텀 헤더 노출 보장 */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'interviewer, X-Interview-Ended, X-Next-Cursor');
  next();
});

/* ===================== 헬스체크 (앱 루트) ===================== */
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ===================== 라우트 마운트 ===================== */
const authEnrich = require('./middleware/authEnrich');
const chatbotRouter = require('./routes/chatbot');
const interviewRouter = require('./routes/interview');
const reportsRouter = require('./routes/reports');

// /chatbot-api/*  -> chatbotRouter
app.use('/chatbot-api', chatbotRouter);

// ⚠️ 반드시 reportsRouter를 먼저 마운트!
// /interview-api/* -> authEnrich -> reportsRouter + interviewRouter
app.use('/interview-api', authEnrich, reportsRouter);   // /interview-api/report/:id 등
app.use('/interview-api', authEnrich, interviewRouter); // 면접 진행(start/chat/tts/stt 등)

// 보조 헬스
app.get('/chatbot-api/health', (_req, res) =>
  res.json({ ok: true, via: 'app.js', ts: Date.now() })
);
app.get('/interview-api/health', (_req, res) =>
  res.json({ ok: true, via: 'app.js', ts: Date.now() })
);

/* ===================== 정적 서빙 (/interview/*) ===================== */
(() => {
  const dist = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.resolve(__dirname, '../frontend/dist');

  const indexHtml = path.join(dist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    // vite.config.js의 base('/interview/')와 일치
    app.use('/interview', express.static(dist, { index: 'index.html', maxAge: '1h' }));

    // SPA 캐치올
    app.get(['/interview', '/interview/*'], (_req, res) => {
      res.sendFile(indexHtml);
    });
  }
})();

/* ===================== 404 핸들러 ===================== */
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

/* ===================== 에러 핸들러 ===================== */
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: 'internal_error',
    detail: err?.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err?.stack }),
  });
});

/* ===================== 서버 시작 ===================== */
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}`);
});

module.exports = app;
