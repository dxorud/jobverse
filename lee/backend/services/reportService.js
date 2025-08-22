// backend/services/reportService.js
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose'); // ★ ObjectId/문자열 혼용 대응

// ✅ Mongoose 모델 직접 사용
const Session = require('../models/session');
const Message = require('../models/message');
const Report  = require('../models/report');

// (선택) 벡터/임베딩 유틸이 있으면 활용, 없으면 안전하게 패스
let vector = {};
try { vector = require('./vector'); } catch (_) {}

/* ------------------------- 임베딩/AI 플래그 ------------------------- */
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  process.env.TEXT2VEC_OPENAI_MODEL ||
  'text-embedding-3-small';

const SIM_THRESHOLD = Number(process.env.SIM_THRESHOLD || 0.74);

function asBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return ['1','true','on','yes','y'].includes(s);
}
function effectiveFlags(flags) {
  const defaultAI  = !!process.env.OPENAI_API_KEY;
  const defaultEmb = !!(process.env.TEXT2VEC_OPENAI_MODEL || process.env.WEAVIATE_HOST || process.env.EMBEDDING_MODEL);

  const envAI  = asBool(process.env.ANALYTICS_USE_OPENAI);
  const envEmb = asBool(process.env.ANALYTICS_USE_EMBEDDINGS);

  const ai  = flags?.openai     !== undefined ? asBool(flags.openai)     : (envAI  ?? defaultAI);
  const emb = flags?.embeddings !== undefined ? asBool(flags.embeddings) : (envEmb ?? defaultEmb);

  return { embeddings: !!emb, openai: !!ai };
}

/* ------------------------- 로컬 분석 유틸 ------------------------- */
const FILLERS = ['음','어','그','약간','그러니까','뭐라','음..','어..'];

const wpm = (text, sec) => {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return sec ? Math.round((words / sec) * 60) : 0;
};
const fillerPerMin = (text, minutes) => {
  if (!minutes) return 0;
  const cnt = (text || '').split(new RegExp(FILLERS.join('|'), 'g')).length - 1;
  return +((cnt / minutes).toFixed(2));
};
const starScore = (text = '') => {
  const has = k => new RegExp(k).test(text);
  const S = +(has('상황') || has('배경'));
  const T = +(has('과제') || has('문제'));
  const A = +(has('행동') || has('어떻게'));
  const R = +(has('결과') || has('성과') || /\d+%|\d+건/.test(text));
  const score = (S + T + A + R) * 25; // 0~100
  return { S: !!S, T: !!T, A: !!A, R: !!R, score };
};
const speechAnalytics = (rounds) => {
  let userMs = 0, allMs = 0, words = 0, fillerCnt = 0, longestPauseSec = 0;
  for (const r of rounds) {
    const sec = r.answer?.durationSec || 0;
    const qsec = r.question?.durationSec || 0;
    const txt = r.answer?.text || '';
    userMs += sec * 1000;
    allMs  += (sec + qsec) * 1000;
    words  += txt.split(/\s+/).filter(Boolean).length;
    fillerCnt += (txt.split(new RegExp(FILLERS.join('|'), 'g')).length - 1);
    longestPauseSec = Math.max(longestPauseSec, r.answer?.maxSilenceSec || 0);
  }
  const minutes = userMs / 60000;
  return {
    talkListenRatio: allMs ? +(userMs / allMs).toFixed(2) : 0,
    avgWpm: minutes ? Math.round(words / minutes) : 0,
    wpmStd: 0,
    fillerPerMin: minutes ? +(fillerCnt / minutes).toFixed(2) : 0,
    longestPauseSec,
    hedgingPct: 0
  };
};

/* ------------------------- 루브릭 ------------------------- */
const defaultRubric = {
  name: 'General',
  items: [
    { id: 'structure', label: '논리 구조', keywords: ['구조','정리','논리'] },
    { id: 'action',    label: '행동 중심', keywords: ['행동','실행','어떻게'] },
    { id: 'result',    label: '결과/수치', keywords: ['결과','성과','%','건'] },
    { id: 'collab',    label: '협업/소통', keywords: ['협업','조율','보고'] },
    { id: 'insight',   label: '인사이트', keywords: ['원인','분석','인사이트'] },
  ],
  suggestions: [
    '결론을 먼저 한 문장으로 말해 보세요.',
    '성과 수치와 영향도를 함께 제시해 보세요.',
  ],
};
function loadRubric(jobRole) {
  const fname = path.join(__dirname, '../rubrics', `${(jobRole || 'general').toLowerCase()}.json`);
  try { if (fs.existsSync(fname)) return JSON.parse(fs.readFileSync(fname, 'utf8')); } catch (_) {}
  return defaultRubric;
}
function rubricCoverageKeyword(text, rubric) {
  if (!rubric?.items?.length) return { coveragePct: 0, matched: [], missing: [], suggestedPhrases: [], method: 'keyword' };
  const matched = [], missing = [];
  for (const it of rubric.items) {
    const hit = (it.keywords || []).some(kw => new RegExp(kw, 'i').test(text || ''));
    (hit ? matched : missing).push(it.label);
  }
  const coveragePct = Math.round((matched.length / rubric.items.length) * 100);
  return { coveragePct, matched, missing, suggestedPhrases: rubric.suggestions || [], method: 'keyword' };
}
async function rubricCoverageEmbedding(text, rubric) {
  try {
    const embed = vector.embed || vector.embedText || vector.encode;
    const cosine = vector.cosine || vector.similarity;
    if (!embed || !cosine) throw new Error('vector functions not found');

    const docEmb = await embed(text || '', { model: EMBEDDING_MODEL });
    const matched = [], missing = [];
    for (const it of (rubric.items || [])) {
      const rep = (it.examples?.[0] || (it.keywords||[]).join(' ') || it.label || '');
      const keyEmb = await embed(rep, { model: EMBEDDING_MODEL });
      const sim = await cosine(docEmb, keyEmb);
      (sim >= SIM_THRESHOLD ? matched : missing).push(it.label);
    }
    const coveragePct = Math.round((matched.length / (rubric.items?.length || 1)) * 100);
    return { coveragePct, matched, missing, suggestedPhrases: rubric.suggestions || [], method: 'embedding' };
  } catch (_) {
    return rubricCoverageKeyword(text, rubric);
  }
}

/* ------------------------- OpenAI 호출 ------------------------- */
async function callOpenAI({ system, user }) {
  if (!process.env.OPENAI_API_KEY) return null;
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: process.env.ANALYSIS_MODEL || 'gpt-4o-mini',
    temperature: Number(process.env.ANALYSIS_TEMPERATURE || 0.2),
    messages: [{ role: 'system', content: system || '' }, { role: 'user', content: user || '' }]
  });
  return res.choices?.[0]?.message?.content?.trim() || null;
}
async function aiSummary({ overall, rubricCoverage, rounds }, flags) {
  if (!flags.openai) return null;
  const bullets = (rounds || []).slice(0, 5).map((r,i)=> `${i+1}) ${(r.answer?.text || '').slice(0, 220)}`);
  const user = [
    `세션 점수=${overall.score}`,
    `강점=${(overall.highlights||[]).join(', ')}`,
    `개선=${(overall.improvements||[]).join(', ')}`,
    `루브릭 커버리지=${rubricCoverage.coveragePct}% (누락: ${(rubricCoverage.missing||[]).join(', ')})`,
    `아래는 라운드별 핵심답변 요약(최대 5개):`,
    bullets.join('\n'),
    '',
    '요청: 1) 3~5문장 요약  2) 다음 연습을 위한 구체 문장 2개(누락 보완)'
  ].join('\n');
  return callOpenAI({ system: '과장 금지, 한국어, 간결.', user });
}
async function aiModelAnswers(rounds, flags) {
  if (!flags.openai) return null;
  const tasks = (rounds || []).map((r) =>
    callOpenAI({
      system: '면접 코치. 한국어. 간결하고 구조화.',
      user: `질문: ${r.question}\n의도: ${r.type||''}\n\n요청: 5~7문장 모범답안. 결론 먼저, 수치/영향 포함.`
    }).then(s => s || '')
  );
  return Promise.all(tasks);
}

/* ------------------------- 라운드 구성 ------------------------- */
// speaker/turn 구조 대응
function roleOf(m) {
  const r = (m.role || m.sender || m.speaker || '').toLowerCase();
  if (['interviewer','assistant','bot','system','agent'].some(k => r.includes(k))) return 'bot';
  if (['candidate','user','applicant'].some(k => r.includes(k))) return 'user';
  return r || 'unknown';
}
function pickText(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (typeof x.text === 'string') return x.text;
  if (typeof x.content === 'string') return x.content;
  if (x.value) return pickText(x.value);
  if (Array.isArray(x)) return x.map(pickText).join('');
  if (typeof x === 'object') {
    return (
      pickText(x.delta) ||
      pickText(x.message) ||
      pickText(x.data) ||
      pickText(x.body) ||
      pickText(x.payload) ||
      pickText(x.segment) ||
      pickText(x.chunk) ||
      pickText(x.args) ||
      ''
    );
  }
  return '';
}
function textOf(m) {
  return (
    m.text ||
    m.content ||
    m.message ||
    pickText(m.payload) ||
    pickText(m.delta) ||
    pickText(m.parts) ||
    pickText(m)
  ) || '';
}

async function buildRoundsFromDB(sessionId, sessionDoc) {
  if (Array.isArray(sessionDoc?.rounds) && sessionDoc.rounds.length) {
    return sessionDoc.rounds.map((r, i) => {
      const aText = r?.answer?.text || '';
      const aSec  = r?.answer?.durationSec || 0;
      return {
        round: r.idx || i + 1,
        type: r.type || '',
        interviewer: r.interviewer || '',
        question: r?.question?.text || r?.question || '',
        answerText: aText,
        answerWpm: wpm(aText, aSec),
        fillerPerMin: fillerPerMin(aText, aSec / 60),
        star: starScore(aText),
        score: Number.isFinite(r?.answer?.score) ? r.answer.score : null,
        pros: [],
        cons: [],
      };
    });
  }

  const sidObj = mongoose.Types.ObjectId.isValid(sessionId)
    ? new mongoose.Types.ObjectId(sessionId)
    : null;

  const msgs = await Message.find({
    $or: [
      sidObj ? { sessionId: sidObj } : null,
      { sessionId: String(sessionId) },
      { 'session._id': sidObj },
      { 'sessionId.$oid': String(sessionId) }
    ].filter(Boolean)
  })
  .sort({ createdAt: 1, _id: 1 })
  .lean();

  if (!msgs.length) return [];

  const byRound = new Map();
  for (const m of msgs) {
    let rnum = Number.isFinite(m.round) ? m.round
              : Number.isFinite(m.turn)  ? m.turn
              : undefined;

    if (!Number.isFinite(rnum)) {
      const last = Array.from(byRound.keys()).pop() || 0;
      const r = roleOf(m);
      rnum = r === 'bot' ? (last + 1) : (last || 1);
    }

    if (!byRound.has(rnum)) {
      byRound.set(rnum, {
        round: rnum,
        type: m.type || '',
        interviewer: m.interviewer || m.interviewerRole || m.agent || m.speaker || '',
        question: '',
        answerText: ''
      });
    }
    const rec = byRound.get(rnum);
    const role = roleOf(m);
    const txt  = textOf(m);

    if (role === 'bot')   rec.question   = (rec.question   ? rec.question + '\n'   : '') + (txt || '');
    if (role === 'user')  rec.answerText = (rec.answerText ? rec.answerText + '\n' : '') + (txt || '');

    byRound.set(rnum, rec);
  }

  return Array.from(byRound.values())
    .sort((a,b)=>a.round-b.round)
    .map(rec => {
      const txt = rec.answerText || '';
      return {
        ...rec,
        answerWpm: wpm(txt, 0),
        fillerPerMin: fillerPerMin(txt, 0),
        star: starScore(txt),
        score: null,
        pros: [],
        cons: [],
      };
    });
}

/* ------------------------- 스킬/비주얼 파생 ------------------------- */
// ★ 유지: 답변이 있으면 최소 40점을 베이스라인으로 사용 (차트가 항상 보이도록)
function skillsFromRounds(rounds) {
  const starArr = rounds.map(r => Number(r.star?.score || 0));
  let avgStar100 = starArr.length ? Math.round(starArr.reduce((a,b)=>a+b,0) / starArr.length) : 0;

  const hasAnyAnswer = rounds.some(r => (r.answerText || '').trim().length > 0);
  if (avgStar100 === 0 && hasAnyAnswer) {
    avgStar100 = 40; // 베이스라인
  }

  const to5 = (n) => {
    const v = Math.max(0, Math.min(100, Number(n) || 0));
    return Math.max(0, Math.min(5, Math.round((v/100)*5 * 10)/10));
  };

  return [
    { key:'communication',  label:'의사소통',     score: to5(avgStar100 * 0.86) },
    { key:'logic',          label:'논리성',       score: to5(avgStar100 * 0.80) },
    { key:'expertise',      label:'전문성',       score: to5(avgStar100 * 0.82) },
    { key:'problemSolving', label:'문제해결력',   score: to5(avgStar100 * 0.78) },
    { key:'attitude',       label:'태도/자신감',  score: to5(avgStar100 * 0.88) },
  ];
}

/** ✅ 한국어 키워드 추출 + 폴백 보장 */
function keywordCountsKo(text, topN = 12) {
  const STOP = new Set([
    '안녕하세요','저는','제가','그리고','그러나','하지만','또는','및',
    '합니다','했습니다','있습니다','입니다','요','은','는','이','가',
    '을','를','에','의','와','과','도','으로','에서','까지','부터',
    '한','좀','거','네','음','어','그','아','했다','같습니다','수','더','또','좀'
  ]);
  const words = (text||'')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => /[\p{L}\p{N}]{2,}/u.test(w))
    .filter(w => !STOP.has(w) && !/^[ㄱ-ㅎ]$/.test(w));
  const map = new Map();
  for (const w of words) map.set(w, (map.get(w)||0)+1);
  const top = Array.from(map.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, topN)
    .map(([word,count])=>({ word, count }));
  if (top.length) return top;

  // 폴백: 규칙 완화해서 6~8개 보장
  const rough = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/)
    .map(w=>w.trim())
    .filter(w => w.length >= 2)
    .slice(0, 100);
  const m = new Map();
  for (const w of rough) m.set(w, (m.get(w)||0)+1);
  return Array.from(m.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 8)
    .map(([word,count])=>({word,count}));
}

/* ------------------------- 리포트 저장 포맷 정규화 ------------------------- */
function normalizeReportDoc(doc) {
  if (!doc) return null;
  const r = doc.toObject ? doc.toObject() : { ...doc };
  r.id = String(r._id || r.sessionId);
  r.basic   = r.basic   || {};
  r.summary = r.summary || {};
  r.rounds  = Array.isArray(r.rounds) ? r.rounds : [];
  r.skills  = Array.isArray(r.skills) ? r.skills : [];
  r.viz     = r.viz     || { radar: [], trend: [], keywords: [] };
  r.extra   = r.extra   || { modelAnswerDiff:'', risks:[], learning:[] };
  return r;
}

/* ------------------------- 메인: 리포트 빌드 ------------------------- */
async function buildReport(sessionId) {
  const session = await Session.findById(sessionId).lean();
  if (!session) throw new Error('Session not found');

  const flags = effectiveFlags({});
  const roundCards = await buildRoundsFromDB(sessionId, session);

  const rubric    = loadRubric(session.jobRole);
  const allText   = roundCards.map(r => r.answerText).join('\n');
  const coverage  = flags.embeddings
    ? await rubricCoverageEmbedding(allText, rubric)
    : rubricCoverageKeyword(allText, rubric);

  const speech = speechAnalytics(
    roundCards.map(r => ({ question:{durationSec:0}, answer:{ durationSec:0, text:r.answerText, maxSilenceSec:0 }}))
  );
  const skills = skillsFromRounds(roundCards);

  const avg5       = skills.reduce((a,b)=>a+b.score,0) / (skills.length || 1);
  const totalScore = Math.round(avg5 * 20);
  const passBand   = totalScore >= 80 ? 'pass-likely' : totalScore >= 65 ? 'border' : 'below';

  const aiSummaryText = await aiSummary({
    overall: { score: totalScore, highlights: [], improvements: [] },
    rubricCoverage: coverage,
    rounds: roundCards.map(r => ({ answer: { text: r.answerText } })),
  }, flags);

  const viz = {
    radar: skills.map(s => ({ key: s.key, label: s.label, score: s.score })),
    trend: roundCards.map(r => ({ round: r.round, score: Math.max(40, Math.min(95, r.star?.score || 0)) })), // 유지
    // ✅ 강화된 키워드 + 폴백
    keywords: keywordCountsKo(allText, 12),
  };

  const roundsForDoc = roundCards.map(r => ({
    round: r.round,
    question: r.question,
    answer: r.answerText,
    pros: r.pros || [],
    cons: r.cons || [],
    score: r.score,
  }));

  const doc = {
    sessionId,
    basic: {
      name: session.userName || session.userId || '지원자',
      jobRole: session.jobRole || '',
      interviewedAt: session.endedAt || session.createdAt || session.startedAt,
      interviewers: Array.isArray(session.interviewers) ? session.interviewers : (session.roles || []),
      rounds: roundsForDoc.length,
    },
    summary: {
      totalScore,
      passBand,
      oneLiner: aiSummaryText || '강점은 의사소통/태도, 사례 구체화 보완 필요',
    },
    rounds: roundsForDoc,
    skills,
    viz,
    extra: {
      modelAnswerDiff: '모범답안은 사례 기반·정량 성과 제시, 실제 답변은 원론적 설명 위주',
      risks: coverage.missing?.length ? [`누락된 루브릭: ${coverage.missing.join(', ')}`] : ['답변 일부 모호'],
      learning: (coverage.suggestedPhrases || []).slice(0, 3),
    }
  };

  const saved = await Report.findOneAndUpdate(
    { sessionId },
    doc,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    if (vector?.upsertForSession) await vector.upsertForSession(String(sessionId), saved);
  } catch (e) {
    console.warn('vector upsert skipped:', e?.message);
  }

  return normalizeReportDoc(saved);
}

/* ------------------------- 조회 API ------------------------- */
async function getReport(sessionId, flagsInput) {
  let rpt = await Report.findOne({ sessionId }).lean();
  const needsRebuild =
    !rpt ||
    !Array.isArray(rpt.rounds) || rpt.rounds.length === 0 ||
    (rpt.summary && Number(rpt.summary.totalScore) === 0);

  if (needsRebuild) {
    const rebuilt = await buildReport(sessionId, flagsInput);
    return normalizeReportDoc(rebuilt);
  }
  return normalizeReportDoc(rpt);
}

async function getReportById(id) {
  const doc = await Report.findById(id);
  return normalizeReportDoc(doc);
}
async function getReportBySession(sessionId) {
  const doc = await Report.findOne({ sessionId });
  return normalizeReportDoc(doc);
}

/* ------------------------- 라운드별 모범답안 ------------------------- */
async function modelAnswerForRound(roundLite, flagsInput) {
  const flags = effectiveFlags(flagsInput);
  const out = await aiModelAnswers([roundLite], flags);
  return Array.isArray(out) ? out[0] || '' : '';
}

module.exports = {
  getReport,
  buildReport,
  getReportById,
  getReportBySession,
  modelAnswerForRound,
};
