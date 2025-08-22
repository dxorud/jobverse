// backend/routes/reports.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { connectMongo, Session, Message } = require('../services/db');
const Report = require('../models/report');
const {
  getReport,
  buildReport,
  modelAnswerForRound
} = require('../services/reportService');

/* ------------------------- utils ------------------------- */
function escapeRegExp(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function parseBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase();
  if (['1','true','on','yes','y'].includes(s)) return true;
  if (['0','false','off','no','n'].includes(s)) return false;
  return def;
}

/* ---------- id 정규화: 세션ID로 바꿔주기 (레거시 호환) ---------- */
async function toSessionId(anyId) {
  // 1) ObjectId면 먼저 Session → Report 순으로 확인
  if (mongoose.isValidObjectId(anyId)) {
    const [ses, rpt] = await Promise.all([
      Session.findById(anyId).select('_id').lean(),
      Report.findById(anyId).select('sessionId').lean()
    ]);
    if (ses?._id) return String(ses._id);
    if (rpt?.sessionId) return String(rpt.sessionId);
    return String(anyId); // 마지막으로 그냥 세션ID로 사용 시도
  }

  // 2) ObjectId가 아니면: 레거시로 Report._id(문자열)일 수 있음
  try {
    const r = await Report.findOne({ _id: anyId }).select('sessionId').lean();
    if (r?.sessionId) return String(r.sessionId);
  } catch (_) {
    /* noop */
  }
  return null;
}

/* ===== 파일명 유틸(한글/특수문자 안전) ===== */
function safeFileBase(s = '') {
  return String(s).replace(/[\\/:*?"<>|]+/g, '').trim();
}
function ymd(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function encodeRFC5987(val = '') {
  return encodeURIComponent(val)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}

/* ========================= 목록 ========================= */
// GET /interview-api/reports?limit=20&q=...&cursor=<_id>
router.get('/reports', async (req, res) => {
  try {
    await connectMongo();

    const limitRaw = Number(req.query.limit);
    const limit = Math.min(Math.max(limitRaw || 20, 1), 100);
    const q = (req.query.q || '').trim();
    const cursor = req.query.cursor;
    const rx = q ? new RegExp(escapeRegExp(q), 'i') : null;

    // 1) 세션 목록(최신순) — _id keyset cursor
    const sesFilter = { deletedAt: null };
    if (rx) sesFilter.$or = [{ userName: rx }, { jobRole: rx }];
    if (cursor && mongoose.isValidObjectId(cursor)) {
      sesFilter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const sessions = await Session.find(sesFilter)
      .sort({ endedAt: -1, startedAt: -1, createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .select('_id userName jobRole startedAt endedAt createdAt')
      .lean();

    let nextCursor = null;
    if (sessions.length === limit + 1) {
      nextCursor = String(sessions[limit]._id);
      sessions.pop();
    }

    // 2) Report 좌측 조인
    const sidList = sessions.map((s) => s._id);
    const rptMap = (await Report.find({ sessionId: { $in: sidList } })
      .select('sessionId basic summary rounds createdAt')
      .lean()
    ).reduce((m, r) => {
      m[String(r.sessionId)] = r;
      return m;
    }, {});

    // 3) 카드 변환
    const items = sessions.map((s) => {
      const sid = String(s._id);
      const rpt = rptMap[sid];

      const name = (s.userName || rpt?.basic?.name || '').trim();
      const role = (s.jobRole || rpt?.basic?.jobRole || '').trim();
      const interviewedAt = s.endedAt || s.startedAt || s.createdAt;

      const totalScore  = rpt?.summary?.totalScore;
      const oneLiner    = rpt?.summary?.oneLiner || '';
      const roles       = rpt?.basic?.interviewers || [];
      const rounds      = (rpt?.basic?.rounds ??
                          (Array.isArray(rpt?.rounds) ? rpt.rounds.length : undefined));
      const durationSec = rpt?.basic?.durationSec;

      return {
        id: sid,   // 세션ID (프론트 라우팅/삭제와 일치)
        _id: sid,
        title: '면접 리포트',
        summary: oneLiner,
        score: totalScore,
        roles,
        rounds,
        durationSec,
        username: name,
        jobRole: role,
        createdAt: interviewedAt,
      };
    });

    return res.json({ items, nextCursor });
  } catch (e) {
    console.error('[GET /reports] error:', e);
    return res.status(500).send('리포트 목록 조회 실패');
  }
});

/* ========================= 상세 ========================= */
// GET /interview-api/reports/:id   ← id는 세션ID 또는 레거시 ReportID
router.get('/reports/:id', async (req, res) => {
  try {
    await connectMongo();
    const { id } = req.params;

    const sessionId = await toSessionId(id);
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      return res.status(400).send('invalid id');
    }

    // 토글: ?ai=1&emb=1
    const flags = {
      openai:     parseBool(req.query.ai,  undefined),
      embeddings: parseBool(req.query.emb, undefined),
    };

    const report = await getReport(sessionId, flags);
    if (!report) return res.status(404).send('not found');
    return res.json(report);
  } catch (e) {
    console.error('[GET /reports/:id] error:', e);
    return res.status(500).send('리포트 상세 조회 실패');
  }
});

// 구 경로 호환: GET /interview-api/report/:id
router.get('/report/:id', async (req, res) => {
  req.url = `/reports/${req.params.id}${req.url.includes('?') ? '&' : '?'}${req.originalUrl.split('?')[1] || ''}`;
  router.handle(req, res);
});

/* ===================== 리포트 생성/업서트 ===================== */
// POST /interview-api/reports/:sessionId/build
router.post('/reports/:sessionId/build', async (req, res) => {
  try {
    await connectMongo();
    const { sessionId } = req.params;
    if (!mongoose.isValidObjectId(sessionId)) return res.status(400).send('invalid sessionId');
    const saved = await buildReport(sessionId);
    return res.json({ ok: true, reportId: String(saved._id), sessionId });
  } catch (e) {
    console.error('[POST /reports/:sessionId/build] error:', e);
    return res.status(500).send('BUILD_FAILED');
  }
});

/* ===== 라운드별 모범답안(on-demand) ===== */
// POST /interview-api/reports/:id/rounds/:idx/model-answer
router.post('/reports/:id/rounds/:idx/model-answer', async (req, res) => {
  try {
    await connectMongo();
    if (typeof modelAnswerForRound !== 'function') {
      return res.status(501).json({ error: 'modelAnswerForRound_not_implemented' });
    }

    const { id, idx } = req.params;
    const sessionId = await toSessionId(id);
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      return res.status(400).send('invalid id');
    }

    const roundIndex = Number(idx);
    if (!Number.isFinite(roundIndex) || roundIndex < 1) {
      return res.status(400).send('invalid round index');
    }

    const rpt = await getReport(sessionId, { openai: false, embeddings: undefined });
    if (!rpt) return res.status(404).send('not found');
    const r = (rpt.rounds || [])[roundIndex - 1];
    if (!r) return res.status(400).send('invalid round');

    const roundLite = { question: r?.question || '', type: r?.type || '', interviewer: r?.interviewer || '' };
    const answer = await modelAnswerForRound(roundLite, { openai: true });
    return res.json({ answer: answer || '' });
  } catch (e) {
    console.error('[POST /reports/:id/rounds/:idx/model-answer] error:', e);
    return res.status(500).send('server_error');
  }
});

// 구 경로 호환
router.post('/report/:id/rounds/:idx/model-answer', async (req, res) => {
  req.url = `/reports/${req.params.id}/rounds/${req.params.idx}/model-answer`;
  router.handle(req, res);
});

/* ========================= PDF ========================= */
// GET /interview-api/reports/:id/pdf   ← id는 세션ID/레거시 ID 모두 허용
router.get('/reports/:id/pdf', async (req, res) => {
  const baseUrl = process.env.PUBLIC_WEB_URL || 'http://localhost:8501';
  const { id } = req.params;

  // 지연 로딩
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch {
    try { puppeteer = require('puppeteer-core'); }
    catch (e2) {
      console.warn('[PDF] puppeteer not installed.', e2?.message);
      return res.status(501).json({ error: 'pdf_not_enabled' });
    }
  }

  try {
    await connectMongo();

    const sessionId = await toSessionId(id);
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      return res.status(400).send('invalid id');
    }

    // 파일명 구성용 데이터 (Report 우선, 없으면 Session)
    const [rpt, ses] = await Promise.all([
      Report.findOne({ sessionId }).lean(),
      Session.findById(sessionId).lean()
    ]);
    const name = safeFileBase(rpt?.basic?.name || ses?.userName || '사용자');
    const role = safeFileBase(rpt?.basic?.jobRole || ses?.jobRole || '직무');
    const when = ymd(rpt?.basic?.interviewedAt || ses?.endedAt || ses?.startedAt || ses?.createdAt || Date.now());
    const filename = `${name}_${role}_${when}.pdf`;

    const url = `${baseUrl}/report/${sessionId}?pdf=1`;

    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
    if (execPath) launchOpts.executablePath = execPath;

    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // 인쇄 품질 개선
    await page.emulateMediaType('print');
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    try { await page.evaluateHandle('document.fonts.ready'); } catch {}
    await page.waitForSelector('.rd-wrap', { timeout: 30000 }).catch(() => {});

    // ▼▼▼ 변경: puppeteer v22+에서 waitForTimeout 제거됨 → 대기 로직 교체
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve()).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    // ▲▲▲ 변경 끝

    // 프린트 전용 스타일 주입 (겹침/그림자/잘림 방지 + 단일열)
    await page.addStyleTag({
      content: `
        @page { size: A4; margin: 14mm 12mm; }
        body { background: #fff !important; }
        .rd-wrap.is-print { width: 100% !important; padding: 0 !important; }
        .rd-header .rd-btn { display: none !important; } /* PDF 버튼 숨김 */
        .rd-card { 
          break-inside: avoid; page-break-inside: avoid;
          box-shadow: none !important; 
          border: 1px solid rgba(0,0,0,.08);
          margin: 10px 0 !important;
        }
        .rd-grid { gap: 14px !important; margin: 14px 0 !important; }
        .rd-grid.three { grid-template-columns: 1fr !important; } /* 단일열 */
      `
    });

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      scale: 1,
    });

    await browser.close();

    const ascii = filename.replace(/[^\x20-\x7E]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(filename)}`
    );
    return res.send(pdf);
  } catch (e) {
    console.error('[GET /reports/:id/pdf] error:', e);
    return res.status(500).send('PDF_FAILED');
  }
});

/* ========================= 삭제 ========================= */
async function findReportByAnyId(id) {
  if (mongoose.isValidObjectId(id)) {
    let rpt = await Report.findById(id).lean();
    if (rpt) return rpt;
    rpt = await Report.findOne({ sessionId: id }).lean();
    if (rpt) return rpt;
    return null;
  }
  try {
    return await Report.findOne({ _id: id }).lean(); // 레거시 문자열 _id
  } catch {
    return null;
  }
}

// DELETE /interview-api/reports/:id
router.delete('/reports/:id', async (req, res) => {
  try {
    await connectMongo();
    const { id } = req.params;

    const rpt = await findReportByAnyId(id);
    const sid = rpt?.sessionId || (mongoose.isValidObjectId(id) ? id : null);
    if (!sid) return res.status(400).json({ error: 'invalid_id' });

    await Promise.allSettled([
      Report.deleteOne(rpt?._id ? { _id: rpt._id } : { sessionId: sid }),
      Session.deleteOne({ _id: sid }),
      Message?.deleteMany ? Message.deleteMany({ sessionId: sid }) : Promise.resolve(),
    ]);

    return res.sendStatus(204);
  } catch (e) {
    console.error('[DELETE /reports/:id] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /interview-api/reports?id=...
router.delete('/reports', async (req, res) => {
  try {
    await connectMongo();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'invalid_id' });

    const rpt = await findReportByAnyId(id);
    const sid = rpt?.sessionId || (mongoose.isValidObjectId(id) ? id : null);
    if (!sid) return res.status(400).json({ error: 'invalid_id' });

    await Promise.allSettled([
      Report.deleteOne(rpt?._id ? { _id: rpt._id } : { sessionId: sid }),
      Session.deleteOne({ _id: sid }),
      Message?.deleteMany ? Message.deleteMany({ sessionId: sid }) : Promise.resolve(),
    ]);

    return res.sendStatus(204);
  } catch (e) {
    console.error('[DELETE /reports?id=] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// 구 경로 호환
router.delete('/report/:id', async (req, res) => {
  req.method = 'DELETE';
  req.url = `/reports/${req.params.id}`;
  router.handle(req, res);
});
router.delete('/report', async (req, res) => {
  req.method = 'DELETE';
  req.url = `/reports?id=${encodeURIComponent(req.query.id || '')}`;
  router.handle(req, res);
});
router.post('/reports/:id/delete', async (req, res) => {
  req.method = 'DELETE';
  req.url = `/reports/${req.params.id}`;
  router.handle(req, res);
});
router.post('/report/:id/delete', async (req, res) => {
  req.method = 'DELETE';
  req.url = `/reports/${req.params.id}`;
  router.handle(req, res);
});

module.exports = router;
