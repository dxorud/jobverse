const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');

const { connectMongo, Session, Message } = require('../services/db');
const { ensureSchema, upsert, findSimilarQuestions } = require('../services/vector');
const { textToSpeech, speechToText } = require('../services/elevenlabs');
const { generateQuickSummary /*, generateFullReport */ } = require('../services/interviewFlow');

/* ===================== ENV ===================== */
const {
  DIFY_API_URL,
  DIFY_AGENT_A_API_KEY,
  DIFY_AGENT_B_API_KEY,
  DIFY_AGENT_C_API_KEY,
  ROUNDS: ROUNDS_RAW,
  round: roundsRawLower,
  SIM_THRESHOLD: SIM_THRESHOLD_RAW,
  FOLLOWUP_RATIO: FOLLOWUP_RATIO_RAW,
} = process.env;

// 안전 파싱
const ROUNDS = Number(ROUNDS_RAW ?? roundsRawLower ?? 8);
const SIM_THRESHOLD = Number(SIM_THRESHOLD_RAW ?? 0.86);
const FOLLOWUP_RATIO = Number(FOLLOWUP_RATIO_RAW ?? 0.6);

const ROLES = ['A', 'B', 'C'];
const AGENT_KEYS = { A: DIFY_AGENT_A_API_KEY, B: DIFY_AGENT_B_API_KEY, C: DIFY_AGENT_C_API_KEY };

/* ===================== Util ===================== */
const pickNextRole = (prev) => {
  const pool = ROLES.filter((r) => r !== prev);
  return pool[Math.floor(Math.random() * pool.length)];
};
const askedCount = (sessionId) => Message.countDocuments({ sessionId, speaker: 'interviewer' });
const lastInterviewerRole = async (sessionId) => {
  const last = await Message.findOne({ sessionId, speaker: 'interviewer' }).sort({ createdAt: -1 });
  return last?.interviewerRole || null;
};
const recentAskedQuestions = async (sessionId, n = 5) => {
  const docs = await Message.find({ sessionId, speaker: 'interviewer' })
    .sort({ createdAt: -1 })
    .limit(n);
  return docs.map((d) => d.text).reverse();
};
const sanitize = (s, max = 1500) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// CORS 헤더 노출
function setExposeHeaders(res) {
  res.setHeader('Access-Control-Expose-Headers', 'interviewer, X-Interview-Ended');
}
function setSSEHeaders(res, { role, ended } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (role) res.setHeader('interviewer', role);
  if (ended) res.setHeader('X-Interview-Ended', '1');
  setExposeHeaders(res);
}

/* ===================== [1] 면접 시작 ===================== */
router.post('/start', async (req, res, next) => {
  try {
    if (!DIFY_API_URL) {
      console.warn('[interview] DIFY_API_URL is not set (start will proceed, but chat may fail).');
    }

    await connectMongo();
    try { await ensureSchema(); } catch (e) { console.warn('[ensureSchema] skip:', e.message); }

    const rawName = (req.user?.name ?? req.body.userName ?? req.body.name ?? '').toString().trim();
    const rawRole = (req.body.jobRole ?? req.body.job ?? '').toString().trim();

    if (!rawName || !rawRole) {
      return res.status(400).json({ error: 'userName and jobRole are required' });
    }

    const userId = req.user?.id || req.body.userId || null;
    const userEmail = req.user?.email || req.body.userEmail || null;

    const cleanName = rawName.length > 30 ? '지원자' : rawName.replace(/[^가-힣a-zA-Z0-9 _-]/g, '');

    const session = await Session.create({
      userName: cleanName,
      userId,
      userEmail,
      jobRole: rawRole,
      status: 'ongoing',
    });

    const role = ROLES[Math.floor(Math.random() * ROLES.length)];
    const firstQuestion = `${cleanName}님, 자기소개 부탁드립니다.`;

    const qDoc = await Message.create({
      sessionId: session._id,
      userName: cleanName,
      userId,
      userEmail,
      speaker: 'interviewer',
      interviewerRole: role,
      turn: 1,
      text: firstQuestion,
    });

    try {
      await upsert('QuestionChunk', {
        text: firstQuestion,
        sessionId: String(session._id),
        userName: cleanName,
        userId,
        userEmail,
        jobRole: rawRole,
        turn: 1,
        mongoMessageId: String(qDoc._id),
        interviewerRole: role,
      });
    } catch (e) { console.warn('[upsert QuestionChunk] skip:', e.message); }

    res.setHeader('interviewer', role);
    setExposeHeaders(res);

    return res.json({ sessionId: session._id, interviewer: role, question: firstQuestion, isFirst: true });
  } catch (e) { next(e); }
});

/* ===================== [2] 후속 질문 (SSE 스트리밍) ===================== */
router.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message: userAnswer } = req.body;
    const userName = (req.user?.name || req.body.userName || req.body.name || '지원자').toString().trim();
    let jobRole = (req.body.jobRole ?? req.body.job ?? '').toString().trim();

    if (!sessionId || !userName || !userAnswer?.trim()) {
      return res.status(422).json({ error: 'sessionId, userName, message는 필수입니다.' });
    }
    if (!DIFY_API_URL) {
      return res.status(500).json({ error: '서버 설정 오류(DIFY_API_URL 미설정)' });
    }

    await connectMongo();
    try { await ensureSchema(); } catch (e) { console.warn('[ensureSchema] skip:', e.message); }

    if (!jobRole) {
      const sess = await Session.findById(sessionId).lean();
      jobRole = sess?.jobRole || '';
    }

    const lastMsg = await Message.findOne({ sessionId }).sort({ createdAt: -1 });

    const currentTurn = lastMsg?.turn || 1;
    const aDoc = await Message.create({
      sessionId,
      userName,
      userId: req.user?.id || req.body.userId || null,
      userEmail: req.user?.email || req.body.userEmail || null,
      speaker: 'user',
      turn: currentTurn,
      text: userAnswer,
    });
    try {
      await upsert('AnswerChunk', {
        text: userAnswer,
        sessionId: String(sessionId),
        userName,
        userId: req.user?.id || req.body.userId || null,
        userEmail: req.user?.email || req.body.userEmail || null,
        jobRole,
        turn: currentTurn,
        mongoMessageId: String(aDoc._id),
      });
    } catch (e) { console.warn('[upsert AnswerChunk] skip:', e.message); }

    const asked = await askedCount(sessionId);
    if (asked >= (Number.isFinite(ROUNDS) ? ROUNDS : 8)) {
      setSSEHeaders(res, { ended: true });
      res.write(`data: ${JSON.stringify({ answer: '면접이 종료되었습니다. 참여해 주셔서 감사합니다.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let avoidFromVector = [];
    try {
      avoidFromVector = await findSimilarQuestions({
        text: userAnswer, sessionId, userName,
        userId: req.user?.id || req.body.userId || null,
        userEmail: req.user?.email || req.body.userEmail || null,
        jobRole, limit: 5,
      });
    } catch (e) { console.warn('[findSimilarQuestions] skip:', e.message); }
    const avoidHints = avoidFromVector
      .filter((s) => s.similarity >= (Number.isFinite(SIM_THRESHOLD) ? SIM_THRESHOLD : 0.86))
      .map((s) => s.text)
      .slice(0, 3);

    const askedQuestions = await recentAskedQuestions(sessionId, 5);
    const askedQuestionsStr = sanitize(askedQuestions.join(' | '), 1500);

    const mode = Math.random() < (Number.isFinite(FOLLOWUP_RATIO) ? FOLLOWUP_RATIO : 0.6) ? 'followup' : 'new_topic';

    const prevRole = await lastInterviewerRole(sessionId);
    const role = pickNextRole(prevRole);
    const apiKey = AGENT_KEYS[role];
    if (!apiKey) return res.status(500).json({ error: '면접관 API 키 누락' });

    const roundNumber = (lastMsg?.turn || 1) + 1;
    const inputs = {
      username: sanitize(userName, 60),
      jobRole: sanitize(jobRole, 80),
      asked_questions: askedQuestionsStr,
      recent_answer: sanitize(userAnswer, 1500),
      round: roundNumber,
    };
    if (asked <= 1) inputs.profile_summary = sanitize(userAnswer, 800);

    const payload = {
      inputs,
      query: [
        `지원자 이름: ${inputs.username}`,
        `지원 직무: ${inputs.jobRole}`,
        askedQuestionsStr ? `이전 질문: ${askedQuestionsStr}` : '',
        `이전 답변: ${inputs.recent_answer}`,
        avoidHints.length ? `다음 주제는 피하라: ${avoidHints.join(' | ')}` : '',
        '',
        mode === 'followup'
          ? '위 답변을 더 깊게 파고드는 후속 질문을 한 문장으로 만들어라.'
          : '아직 다루지 않은 역량을 검증할 새로운 질문을 한 문장으로 만들어라.',
      ].filter(Boolean).join('\n'),
      response_mode: 'streaming',
      user: String(sessionId),
    };

    const stream = await axios({
      method: 'POST',
      url: `${DIFY_API_URL}/chat-messages`,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      data: payload,
      responseType: 'stream',
      timeout: 60_000,
    });

    setSSEHeaders(res, { role });
    if (res.flushHeaders) res.flushHeaders();

    const hb = setInterval(() => { if (!res.writableEnded) res.write(':\n\n'); }, 25000);
    req.on('close', () => { clearInterval(hb); try { stream.data.destroy(); } catch {} });

    let fullQuestion = '';
    stream.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter((line) => line.startsWith('data:'));
      for (const line of lines) {
        const jsonPart = line.replace(/^data:\s*/, '');
        try {
          const parsed = JSON.parse(jsonPart);
          if (parsed.answer) fullQuestion += parsed.answer;
        } catch (_) {}
        res.write(`data: ${jsonPart}\n\n`);
      }
    });

    stream.data.on('end', async () => {
      clearInterval(hb);

      const safeQuestion = (fullQuestion || '').trim();
      if (!safeQuestion) {
        res.write(`data: ${JSON.stringify({ answer: '한 번만 더 자세히 말씀해 주실 수 있을까요?' })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const nextTurn = (lastMsg?.turn || 1) + 1;
      const qDoc = await Message.create({
        sessionId,
        userName,
        userId: req.user?.id || req.body.userId || null,
        userEmail: req.user?.email || req.body.userEmail || null,
        speaker: 'interviewer',
        interviewerRole: role,
        turn: nextTurn,
        text: safeQuestion,
      });
      try {
        await upsert('QuestionChunk', {
          text: safeQuestion,
          sessionId: String(sessionId),
          userName,
          userId: req.user?.id || req.body.userId || null,
          userEmail: req.user?.email || req.body.userEmail || null,
          jobRole,
          turn: nextTurn,
          mongoMessageId: String(qDoc._id),
          interviewerRole: role,
        });
      } catch (e) { console.warn('[upsert QuestionChunk] skip:', e.message); }

      res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.data.on('error', (err) => {
      clearInterval(hb);
      console.error('Dify stream error:', err?.message || err);
      if (!res.headersSent) res.status(502).json({ error: 'Dify 스트림 오류' });
      else try { res.end(); } catch {}
    });
  } catch (e) { next(e); }
});

/* ===================== [3] 텍스트 → 음성 ===================== */
router.post('/tts', async (req, res) => {
  try {
    const { text, role = 'DEFAULT' } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text는 필수입니다.' });
    const audio = await textToSpeech(text, role);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audio));
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: 'TTS 오류', detail: e.message });
  }
});

/* ===================== [4] 음성 → 텍스트 ===================== */
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB
router.post('/stt', upload.single('file'), async (req, res) => {
  try {
    const { originalname, buffer, mimetype } = req.file || {};
    if (!buffer) return res.status(400).json({ error: '파일이 없습니다.' });
    const text = await speechToText(buffer, originalname || 'audio.webm', mimetype || 'audio/webm');
    res.json({ text });
  } catch (e) {
    console.error('STT error:', e.message);
    res.status(500).json({ error: 'STT 오류', detail: e.message });
  }
});

/* ===================== [5] 요약 / 리포트 ===================== */
router.get('/summary/:sessionId', async (req, res, next) => {
  try {
    const out = await generateQuickSummary(req.params.sessionId);
    res.json(out);
  } catch (e) { next(e); }
});

// router.get('/report/:sessionId', async (req, res, next) => {
//   try {
//     const report = await generateFullReport(req.params.sessionId);
//     res.json(report);
//   } catch (e) { next(e); }
// });

module.exports = router;
