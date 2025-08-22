import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import './ReportPage.css';

import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip
} from 'recharts';

/* ===== Recharts custom tick: '태도/자신감' 같은 라벨 줄바꿈 ===== */
function AngleTick({ payload, x, y }) {
  const lines = String(payload?.value ?? '').split('/'); // '태도/자신감' -> ['태도','자신감']
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={12} fill="#6b7280">
      {lines.map((t, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 14}>{t}</tspan>
      ))}
    </text>
  );
}

export default function ReportPage({ baseUrl = import.meta.env.VITE_API_BASE || '', authHeaders = {} }) {
  const { id } = useParams();
  const { search } = useLocation();
  const isPdf = useMemo(() => new URLSearchParams(search).get('pdf') === '1', [search]);
  const apiBase = useMemo(() => (baseUrl || '').replace(/\/+$/, ''), [baseUrl]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [modelAns, setModelAns] = useState({});
  const [loadingAns, setLoadingAns] = useState({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true); setErr('');
        const r = await fetch(`${apiBase}/interview-api/reports/${encodeURIComponent(id)}`, { headers: authHeaders });
        if (!r.ok) throw new Error(`DETAIL_FAILED ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        setData(j);
      } catch (e) {
        if (alive) setErr(e?.message || '리포트를 불러오지 못했어요.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [apiBase, id, authHeaders]);

  const onFetchModelAnswer = async (round) => {
    try {
      setLoadingAns((m) => ({ ...m, [round]: true }));
      const r = await fetch(
        `${apiBase}/interview-api/reports/${encodeURIComponent(id)}/rounds/${round}/model-answer`,
        { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' } }
      );
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && typeof j.answer === 'string') {
        setModelAns((m) => ({ ...m, [round]: j.answer }));
      } else {
        throw new Error('모범답안을 불러오지 못했어요.');
      }
    } catch (e) {
      setModelAns((m) => ({ ...m, [round]: `⚠ ${e?.message || '오류'}` }));
    } finally {
      setLoadingAns((m) => ({ ...m, [round]: false }));
    }
  };

  if (loading) {
    return (
      <div className={`rd-wrap ${isPdf ? 'is-print' : ''}`}>
        <div className="rd-skeleton" />
        <div className="rd-skeleton small" />
        <div className="rd-skeleton tall" />
      </div>
    );
  }
  if (err) return <div className="rd-wrap"><div className="rd-error">{err}</div></div>;
  if (!data) return null;

  const basic   = data.basic || {};
  const summary = data.summary || {};
  const skills  = Array.isArray(data.skills) ? data.skills : [];
  const rounds  = Array.isArray(data.rounds) ? data.rounds : [];
  const viz     = data.viz || {};
  const extra   = data.extra || {};
  const pdfHref = `${apiBase}/interview-api/reports/${encodeURIComponent(id)}/pdf`;

  const radarData = (viz.radar?.length ? viz.radar : skills).map(s => ({ subject: s.label || s.key, A: n5(s.score) }));
  const trendData = (viz.trend || []).map(t => ({ name: `R${t.round}`, score: t.score }));

  return (
    <div className={`rd-wrap ${isPdf ? 'is-print' : ''}`}>
      {/* 헤더 */}
      <header className="rd-header">
        <div className="rd-head-left">
          <h1 className="rd-title">
            <span className="rd-name">{basic.name || '지원자'}</span>
            <span className="rd-role-pill">{basic.jobRole || '직무'}</span>
          </h1>
          <p className="rd-dim">면접일: {fmtDateTime(basic.interviewedAt || data.createdAt)}</p>
          {Array.isArray(basic.interviewers) && basic.interviewers.length > 0 && (
            <p className="rd-dim">면접관: {basic.interviewers.join(', ')}</p>
          )}
        </div>
        <div className="rd-head-right">
          {typeof summary.totalScore === 'number' && (
            <span className="rd-chip">
              <strong className="rd-chip-num">{summary.totalScore}</strong>
              <span className="rd-chip-sub">점</span>
            </span>
          )}
          <span className={`rd-band ${bandClass(summary.passBand)}`}>
            {gradeLetter(summary.totalScore, summary.passBand)}
          </span>
          {!isPdf && (
            <a href={pdfHref} target="_blank" rel="noreferrer" className="rd-btn">PDF 다운로드</a>
          )}
        </div>
      </header>

      {/* 한 줄 요약 */}
      {summary.oneLiner && (
        <section className="rd-card rd-hero">
          <h2 className="rd-sec-title">한 줄 요약</h2>
          <p className="rd-body">{summary.oneLiner}</p>
        </section>
      )}

      {/* 상단 3분할: 역량/레이다/추이 */}
      <section className="rd-grid three">
        <div className="rd-card">
          <h3 className="rd-sec-title">역량별 점수</h3>
          <ul className="rd-skill-list">
            {skills.length ? skills.map((s) => (
              <li key={s.key} className="rd-skill-row">
                <span className="rd-skill-name">{s.label || s.key}</span>
                <div className="rd-bar">
                  <div className="rd-bar-fill" style={{ width: `${(n5(s.score) / 5) * 100}%` }} />
                </div>
                <span className="rd-skill-score">{fmtScore5(s.score)}</span>
              </li>
            )) : <li className="rd-dim">데이터가 없습니다.</li>}
          </ul>
        </div>

        <div className="rd-card">
          <h3 className="rd-sec-title">레이더 차트</h3>
          <div className="rd-chart">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart
                data={radarData}
                margin={{ top: 10, right: 20, bottom: 10, left: 28 }} // 왼쪽 여백 살짝 증가
              >
                <PolarGrid />
                {/* 각도 축 라벨을 줄바꿈해서 '태도/자신감' 안 잘리게 */}
                <PolarAngleAxis dataKey="subject" tick={<AngleTick />} />
                {/* 반지름 눈금(숫자) 제거 */}
                <PolarRadiusAxis domain={[0, 5]} tick={false} axisLine={false} />
                <Radar name="역량" dataKey="A" stroke="#6C5CE7" fill="#6C5CE7" fillOpacity={0.35} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rd-card">
          <h3 className="rd-sec-title">라운드별 점수 추이</h3>
          <div className="rd-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis domain={[0, 100]} />
                <Tooltip />
                <Line type="monotone" dataKey="score" stroke="#8E7CFF" dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* 키워드 클라우드 */}
      <section className="rd-card">
        <h3 className="rd-sec-title">키워드</h3>
        <div className="rd-tags">
          {(viz.keywords || []).slice(0, 40).map((k) => (
            <span key={k.word} className="rd-tag" title={`count: ${k.count}`}
              style={{ fontSize: clamp(12, 12 + (k.count || 1), 22) }}>
              {k.word}
            </span>
          ))}
          {!viz.keywords?.length && <span className="rd-dim">데이터가 없습니다.</span>}
        </div>
      </section>

      {/* 라운드 테이블 */}
      <section className="rd-card">
        <h3 className="rd-sec-title">라운드별 분석</h3>
        <div className="rd-table-wrap">
          <table className="rd-table">
            <thead>
              <tr>
                <th>라운드</th>
                <th>질문</th>
                <th>답변 요약</th>
                <th>장점</th>
                <th>개선</th>
                <th>모범답안</th>
              </tr>
            </thead>
            <tbody>
              {rounds.length ? rounds.map((r) => (
                <tr key={r.round}>
                  <td className="rd-td-num">{r.round}</td>
                  <td className="rd-pre">{r.question || '-'}</td>
                  <td className="rd-pre rd-ans">{(r.answer || '').slice(0, 500)}</td>
                  <td className="rd-pre">{(r.pros || []).join('\n') || '-'}</td>
                  <td className="rd-pre">{(r.cons || []).join('\n') || '-'}</td>
                  <td className="rd-td-actions">
                    {!isPdf && (
                      <button
                        className="rd-btn tiny"
                        onClick={() => onFetchModelAnswer(r.round)}
                        disabled={!!loadingAns[r.round]}
                      >
                        {loadingAns[r.round] ? '불러오는 중…' : (modelAns[r.round] ? '다시 보기' : '보기')}
                      </button>
                    )}
                    {modelAns[r.round] && <div className="rd-pre rd-model">{modelAns[r.round]}</div>}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={6} className="rd-dim center">데이터가 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 보조 패널 3분할 */}
      <section className="rd-grid three">
        <div className="rd-card">
          <h3 className="rd-sec-title">모범답안 vs 실제</h3>
          <p className="rd-pre">{extra.modelAnswerDiff || '—'}</p>
        </div>
        <div className="rd-card">
          <h3 className="rd-sec-title">리스크 포인트</h3>
          <ul className="rd-list">
            {(extra.risks || []).length
              ? extra.risks.map((x, i) => <li key={i}>{x}</li>)
              : <li className="rd-dim">—</li>}
          </ul>
        </div>
        <div className="rd-card">
          <h3 className="rd-sec-title">추천 학습 방향</h3>
          <ul className="rd-list">
            {(extra.learning || []).length
              ? extra.learning.map((x, i) => <li key={i}>{x}</li>)
              : <li className="rd-dim">—</li>}
          </ul>
        </div>
      </section>

      <footer className="rd-foot">
        <div>Report ID: {String(data._id || id)}</div>
        <div>Generated: {fmtDateTime(data.updatedAt || data.createdAt)}</div>
      </footer>
    </div>
  );
}

/* ===== helpers ===== */
function bandClass(band) {
  if (band === 'pass-likely') return 'is-pass';
  if (band === 'border') return 'is-border';
  if (band === 'below') return 'is-below';
  return '';
}
function gradeLetter(score, band) {
  if (band === 'pass-likely') return 'A';
  if (band === 'border') return 'B';
  if (band === 'below') return 'C';
  const s = Number(score);
  if (!Number.isFinite(s)) return '-';
  if (s >= 90) return 'A+';
  if (s >= 85) return 'A';
  if (s >= 75) return 'B+';
  if (s >= 65) return 'B';
  return 'C';
}
function fmtScore5(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return '-';
  return `${(Math.round(n * 10) / 10).toFixed(1)} / 5`;
}
function n5(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
}
function clamp(min, v, max) { return Math.max(min, Math.min(max, v)); }
function fmtDateTime(v) {
  if (!v) return '';
  try {
    const d = new Date(v);
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch { return String(v); }
}
