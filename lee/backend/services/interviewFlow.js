// services/interviewFlow.js
const axios = require('axios');
const { connectMongo, Session, Message } = require('./db');
const { ensureSchema, upsert, findSimilarQuestions } = require('./vector');
// 질문 생성은 Dify 에이전트 사용
const { askAgentByRole } = require('./difyInterview');

/* ===================== ENV / CONST ===================== */
const _roundsRaw = (process.env.ROUNDS ?? process.env.round ?? 5);
const ROUNDS = Math.max(0, Number(_roundsRaw)) || 5;

const SIM_THRESHOLD = Number(process.env.SIM_THRESHOLD || 0.86);

const ROLES = ['A', 'B', 'C'];

// OpenAI 요약 모델 설정 (ANALYSIS_MODEL > OPENAI_SUMMARY_MODEL > 기본값)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUMMARY_MODEL =
  process.env.ANALYSIS_MODEL ||
  process.env.OPENAI_SUMMARY_MODEL ||
  'gpt-4o-mini';

// 안전치(문자 수). 이보다 길면 부분 요약 → 병합
const HARD_LIMIT = 9000;

/* ===================== UTILS ===================== */
const pickNext = (prev) => {
  const pool = ROLES.filter((r) => r !== prev);
  return pool[Math.floor(Math.random() * pool.length)];
};

async function getSessionMessages(sessionId) {
  await connectMongo();
  return Message.find({ sessionId }).sort({ createdAt: 1 });
}

function toTranscript(messages) {
  return messages
    .map((m) => {
      const who = m.speaker === 'interviewer'
        ? `Q${m.turn || ''}(${m.interviewerRole || ''})`
        : `A${m.turn || ''}`;
      return `${who}: ${m.text}`;
    })
    .join('\n');
}

function splitByLength(s, max = 8000) {
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

function coerceJsonAnswer(raw) {
  if (!raw) return { summary: '', bullets: [] };
  // 1) 순수 JSON 시도
  try {
    const j = JSON.parse(raw);
    if (j && (j.summary || j.bullets)) {
      return {
        summary: String(j.summary || '').trim(),
        bullets: Array.isArray(j.bullets) ? j.bullets.map(String) : [],
      };
    }
  } catch {}
  // 2) 본문에서 JSON 블록 추출
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return {
        summary: String(j.summary || '').trim(),
        bullets: Array.isArray(j.bullets) ? j.bullets.map(String) : [],
      };
    } catch {}
  }
  // 3) fallback: 간이 파싱
  const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  const bullets = lines
    .filter((l) => /^[\-•*]/.test(l))
    .map((l) => l.replace(/^[\-•*]\s?/, '').trim())
    .slice(0, 6);
  const summary = lines.find((l) => !/^[\-•*]/.test(l)) || raw.slice(0, 600);
  return { summary, bullets };
}

async function callOpenAI(messages, { temperature = 0.3 } = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set (요약 생성에 필요)');
  }
  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: SUMMARY_MODEL, messages, temperature },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );
  return (data?.choices?.[0]?.message?.content || '').trim();
}

/* ===================== 짧은 분석(요약) ===================== */
/**
 * 반환: { summary: string, bullets: string[] }
 * - MongoDB에서 대화 전체를 읽어 transcript 구성
 * - OpenAI로 JSON 요약 요청
 */
async function generateQuickSummary(sessionId) {
  await connectMongo();

  const sess = await Session.findById(sessionId).lean();
  if (!sess) return { summary: '세션을 찾을 수 없습니다.', bullets: [] };

  const msgs = await getSessionMessages(sessionId);
  if (!msgs.length) return { summary: '대화 기록이 없습니다.', bullets: [] };

  const transcript = toTranscript(msgs);
  const userName = sess.userName || '지원자';
  const jobRole = sess.jobRole || '';

  const system = [
    '당신은 한국어 면접 평가 보조자입니다.',
    '아래 면접 대화를 읽고:',
    '1) 5~7문장으로 전반적인 수행 요약(summary)',
    '2) 4~6개의 핵심 관찰 포인트(bullets) — 강점과 보완점을 균형 있게',
    '반드시 다음 **JSON만** 반환하세요 (추가 텍스트 금지):',
    '{ "summary": "...", "bullets": ["...","..."] }',
  ].join('\n');

  const prefix = [`지원자: ${userName}`, `직무: ${jobRole}`, '', '--- 대화 기록 ---'].join('\n');

  try {
    // 길면 부분 요약 → 병합
    if (transcript.length > HARD_LIMIT) {
      const chunks = splitByLength(transcript, 8000);
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const raw = await callOpenAI([
          { role: 'system', content: system },
          { role: 'user', content: `${prefix}\n(부분 ${i + 1}/${chunks.length})\n${chunks[i]}` },
        ]);
        parts.push(coerceJsonAnswer(raw));
      }
      const fuseSystem = [
        '여러 부분 요약을 받아 최종 요약을 만듭니다.',
        'JSON만 반환하세요: { "summary": "...", "bullets": ["..."] }',
      ].join('\n');
      const fuseUser = [
        `지원자: ${userName}`,
        `직무: ${jobRole}`,
        '',
        '--- 부분 요약들(JSON) ---',
        JSON.stringify(parts, null, 2),
      ].join('\n');
      const fusedRaw = await callOpenAI([
        { role: 'system', content: fuseSystem },
        { role: 'user', content: fuseUser },
      ]);
      const fused = coerceJsonAnswer(fusedRaw);
      return {
        summary: fused.summary || '(요약 없음)',
        bullets: Array.isArray(fused.bullets) ? fused.bullets.filter(Boolean) : [],
      };
    }

    // 단일 호출
    const raw = await callOpenAI([
      { role: 'system', content: system },
      { role: 'user', content: `${prefix}\n${transcript}` },
    ]);
    const parsed = coerceJsonAnswer(raw);
    return {
      summary: parsed.summary || '(요약 없음)',
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.filter(Boolean) : [],
    };
  } catch (e) {
    console.error('[generateQuickSummary] OpenAI error:', e?.message || e);
    return { summary: '요약을 생성하지 못했습니다.', bullets: [] };
  }
}

/* ===================== 세션 / 질문 흐름 ===================== */
async function startSession({ userName, userId, jobRole }) {
  await connectMongo();
  await ensureSchema();
  const s = await Session.create({
    userName,
    userId,
    jobRole,
    status: 'ongoing',
  });
  return { sessionId: s._id, displayName: userName };
}

async function handleUserAnswer({
  sessionId,
  userName,
  userId,
  jobRole,
  turn,
  userAnswer,
}) {
  await connectMongo();
  await ensureSchema();

  // 1) 사용자 답변 저장 + 업서트(실패해도 전체 흐름 유지)
  let a;
  try {
    a = await Message.create({
      sessionId,
      userName,
      userId,
      speaker: 'user',
      turn,
      text: userAnswer,
    });
    try {
      await upsert('AnswerChunk', {
        text: userAnswer,
        sessionId: String(sessionId),
        userName,
        userId,
        jobRole,
        turn,
        mongoMessageId: String(a._id),
      });
    } catch (e) {
      console.warn('[upsert AnswerChunk] skip:', e.message);
    }
  } catch (e) {
    console.warn('[Message.create user] failed:', e.message);
  }

  // 2) 중복질문 회피 힌트(실패해도 진행)
  let hints = [];
  try {
    const similar = await findSimilarQuestions({
      text: userAnswer,
      sessionId,
      userName,
      jobRole,
      limit: 5,
    });
    hints = (similar || [])
      .filter((s) => s.similarity >= SIM_THRESHOLD)
      .map((s) => s.text)
      .slice(0, 3);
  } catch (e) {
    console.warn('[findSimilarQuestions] skip:', e.message);
  }

  // 3) 다음 면접관 선택 + 질문 생성(실패 시 대체 질문)
  const lastQ = await Message.findOne({
    sessionId,
    speaker: 'interviewer',
  }).sort({ createdAt: -1 });
  const role = pickNext(lastQ?.interviewerRole);

  let nextQuestion = '';
  try {
    nextQuestion = await askAgentByRole(role, {
      input: userAnswer,
      variables: { userName, jobRole, avoid: hints },
    });
  } catch (e) {
    console.warn('[askAgentByRole] fallback:', e.message);
    nextQuestion = '조금 더 자세히 설명해 주실 수 있을까요?';
  }

  // 4) 질문 저장 + 업서트(실패해도 isEnd 계산은 가능)
  try {
    const q = await Message.create({
      sessionId,
      userName,
      userId,
      speaker: 'interviewer',
      interviewerRole: role,
      turn: turn + 1,
      text: nextQuestion,
    });
    try {
      await upsert('QuestionChunk', {
        text: nextQuestion,
        sessionId: String(sessionId),
        userName,
        userId,
        jobRole,
        turn: turn + 1,
        mongoMessageId: String(q._id),
        interviewerRole: role,
      });
    } catch (e) {
      console.warn('[upsert QuestionChunk] skip:', e.message);
    }
  } catch (e) {
    console.warn('[Message.create interviewer] failed:', e.message);
  }

  // 5) 종료 판정(면접관 질문 수 기준)
  let asked = 0;
  try {
    asked = await Message.countDocuments({
      sessionId,
      speaker: 'interviewer',
    });
  } catch (e) {
    console.warn('[countDocuments interviewer] fail:', e.message);
  }

  return {
    nextQuestion,
    role,
    isEnd: asked >= ROUNDS,
    similarUsed: hints,
  };
}

async function finishSession(sessionId) {
  await connectMongo();
  await Session.findByIdAndUpdate(sessionId, {
    status: 'ended',
    endedAt: new Date(),
  });
}

module.exports = {
  startSession,
  handleUserAnswer,
  finishSession,
  generateQuickSummary,
};
