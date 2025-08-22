import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import './Report.css';

export default function Report({
  baseUrl = import.meta.env.VITE_API_BASE || '',
  authHeaders,
  listPath = '/interview-api/reports',
  pageSize = 15, // 페이지당 15개
}) {
  const navigate = useNavigate();
  const { state } = useLocation();
  const highlightId = state?.sessionId;

  // 페이지네이션 상태
  // pages: [{ items, nextCursor }]
  const [pages, setPages] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [deletingIds, setDeletingIds] = useState({});

  const cardRefs = useRef(new Map());
  const apiBase = useMemo(() => (baseUrl || '').replace(/\/+$/, ''), [baseUrl]);

  /* ---------------- 공통 URL 빌더 ---------------- */
  const ensurePath = (p) => (p?.startsWith('/') ? p : `/${p || ''}`);
  const makeListUrl = (cursor = null, query = '') => {
    const u = new URL(`${apiBase}${ensurePath(listPath)}`, window.location.origin);
    u.searchParams.set('limit', String(pageSize));
    if (query?.trim()) u.searchParams.set('q', query.trim());
    if (cursor) u.searchParams.set('cursor', cursor);
    return u.pathname + u.search;
  };

  /* ---------------- 목록: 첫 페이지 로드 + 검색 ---------------- */
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const { signal } = ctrl;

    async function loadFirst() {
      setLoading(true);
      setErr('');
      setPages([]);
      setPageIndex(0);
      try {
        const url = makeListUrl(null, q);
        const r = await fetch(url, { headers: { ...(authHeaders || {}) }, signal });
        const text = await r.text();
        if (!r.ok) throw new Error(text || `리포트 목록 조회 실패 (HTTP ${r.status})`);
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          throw new Error(`JSON이 아닌 응답입니다 (content-type=${ct}).\n${text.slice(0, 180)}`);
        }
        const d = JSON.parse(text);
        if (!alive) return;
        const items = Array.isArray(d) ? d : (d.items || []);
        setPages([{ items: normalize(items), nextCursor: d.nextCursor || null }]);
      } catch (e) {
        if (!alive || signal.aborted) return;
        setErr(e?.message || '리포트 목록을 불러오지 못했어요.');
      } finally {
        if (!alive || signal.aborted) return;
        setLoading(false);
      }
    }

    loadFirst();
    return () => { alive = false; ctrl.abort(); };
  }, [apiBase, authHeaders, listPath, pageSize, q]);

  /* ---------------- 다음 페이지 로드 ---------------- */
  async function loadNextPage() {
    const last = pages[pages.length - 1];
    if (!last?.nextCursor) return;
    setLoading(true);
    setErr('');
    try {
      const url = makeListUrl(last.nextCursor, q);
      const r = await fetch(url, { headers: { ...(authHeaders || {}) } });
      const text = await r.text();
      if (!r.ok) throw new Error(text || `리포트 목록 조회 실패 (HTTP ${r.status})`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(`JSON이 아닌 응답입니다 (content-type=${ct}).\n${text.slice(0, 180)}`);
      }
      const d = JSON.parse(text);
      const items = Array.isArray(d) ? d : (d.items || []);
      setPages((pp) => [...pp, { items: normalize(items), nextCursor: d.nextCursor || null }]);
      setPageIndex((i) => i + 1);
    } catch (e) {
      setErr(e?.message || '리포트 목록을 불러오지 못했어요.');
    } finally {
      setLoading(false);
    }
  }

  /* ---------------- 하이라이트 스크롤 ---------------- */
  useEffect(() => {
    if (!highlightId || !pages.length) return;
    const current = pages[pageIndex]?.items || [];
    const has = current.some((it) => it.id === highlightId);
    if (!has) return;
    const el = cardRefs.current.get(highlightId);
    if (el && typeof el.scrollIntoView === 'function') {
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    }
  }, [highlightId, pages, pageIndex]);

  /* ---------------- 네비게이션 ---------------- */
  const currentItems = pages[pageIndex]?.items || [];
  const canPrev = pageIndex > 0;

  // 버튼 표시를 통일: '알고 있는' 페이지 수 = (불러온 페이지 수) + (다음 커서가 있으면 +1)
  const lastPage = pages[pages.length - 1];
  const knownPages = pages.length + (lastPage?.nextCursor ? 1 : 0);
  const canNext = pageIndex < knownPages - 1;

  const showPager = pages.length > 0 || canPrev || canNext;

  const onOpen = (id) => navigate(`/report/${encodeURIComponent(id)}`, { state: { from: 'list' } });

  /* ---------------- 삭제: 여러 후보 경로 자동 시도 ---------------- */
  const buildDeleteCandidates = (id) => {
    const idEnc = encodeURIComponent(id);
    const base = `${apiBase}${ensurePath(listPath)}`.replace(/\/+$/, '');
    const singularBase = base.replace(/s(?=\/?$)/, ''); // reports -> report

    return [
      { method: 'DELETE', url: `${base}/${idEnc}` },
      { method: 'DELETE', url: `${base}?id=${idEnc}` },
      { method: 'DELETE', url: `${singularBase}/${idEnc}` },
      { method: 'DELETE', url: `${singularBase}?id=${idEnc}` },
      { method: 'POST',   url: `${base}/${idEnc}/delete` },
      { method: 'POST',   url: `${singularBase}/${idEnc}/delete` },
    ];
  };

  async function tryDeleteRequest(id) {
    const candidates = buildDeleteCandidates(id);
    let lastMsg = '';
    for (const c of candidates) {
      try {
        const r = await fetch(c.url, {
          method: c.method,
          headers: { ...(authHeaders || {}), ...(c.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        });
        if (r.ok || r.status === 204) return { ok: true };
        const txt = await r.text().catch(() => '');
        const message =
          parseServerError(txt) ||
          `${c.method} ${new URL(c.url, window.location.origin).pathname} → HTTP ${r.status}`;
        lastMsg = message;
        if ([401, 403].includes(r.status)) return { ok: false, msg: message };
      } catch (e) {
        lastMsg = e?.message || '네트워크 오류';
      }
    }
    return { ok: false, msg: lastMsg || '삭제 엔드포인트를 찾지 못했어요.' };
  }

  async function onDelete(e, it) {
    e.stopPropagation();
    e.preventDefault();
    const name = it.title || it.username || '면접 리포트';
    if (!window.confirm(`정말 삭제할까요?\n“${name}”`)) return;

    setDeletingIds((m) => ({ ...m, [it.id]: true }));
    const res = await tryDeleteRequest(it.id);
    if (res.ok) {
      setPages((pp) => pp.map((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) })));
    } else {
      setErr(res.msg || '삭제에 실패했어요.');
      console.warn('Delete failed:', res.msg, 'tried:', buildDeleteCandidates(it.id));
    }
    setDeletingIds((m) => {
      const { [it.id]: _, ...rest } = m;
      return rest;
    });
  }

  return (
    <div className="report-wrap">
      {/* 상단 헤더 + 검색 */}
      <header className="report-header">
        <div className="report-titles">
          <h1 className="report-h1">면접 리포트</h1>
          <p className="report-sub">지난 면접 세션의 요약과 점수를 한눈에 확인하세요.</p>
        </div>
        <div className="report-tools">
          <input
            className="report-search"
            aria-label="검색"
            placeholder="이름/직무 검색…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </header>

      {/* 로딩/에러/빈 상태 */}
      {loading && pages.length === 0 && (
        <div className="report-grid" aria-live="polite">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skel-card" />
          ))}
        </div>
      )}
      {!loading && err && <p className="report-info report-info--error">{err}</p>}
      {!loading && !err && pages.length > 0 && currentItems.length === 0 && (
        <p className="report-info">표시할 리포트가 없어요.</p>
      )}

      {/* 카드 그리드 */}
      {currentItems.length > 0 && (
        <div className="report-grid">
          {currentItems.map((it) => {
            const isHL = highlightId && (it.id === highlightId);
            return (
              <article
                key={it.id}
                ref={(el) => el && cardRefs.current.set(it.id, el)}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(it.id)}
                onKeyDown={(e) => (e.key === 'Enter') && onOpen(it.id)}
                aria-label={`리포트 열기: ${it.title || '면접 리포트'}`}
                className={`report-card ${isHL ? 'report-card--highlight' : ''}`}
              >
                {/* 삭제 버튼 */}
                <button
                  className="report-del"
                  aria-label="리포트 삭제"
                  title="삭제"
                  onClick={(e) => onDelete(e, it)}
                  disabled={!!deletingIds[it.id]}
                >
                  {deletingIds[it.id] ? '…' : '❌'}
                </button>

                {/* 상단: 제목 (점수 배지 숨김) */}
                <div className="report-card-head">
                  <h2 className="report-card-title">{it.title || '면접 리포트'}</h2>
                  {/* 점수 숨김
                  {typeof it.score === 'number' && (
                    <span className="report-badge">{Math.round(it.score)}점</span>
                  )} */}
                </div>

                {/* 인물 */}
                {(it.username || it.jobRole) && (
                  <div className="report-person">
                    {it.username && <div className="person-name">{it.username}</div>}
                    {it.jobRole && <div className="person-role">{it.jobRole}</div>}
                  </div>
                )}

                {/* 요약 숨김 */}
                {/* {it.summary && <p className="report-summary">{it.summary}</p>} */}

                {/* 태그 (라운드 수 숨김) */}
                <div className="report-tags">
                  {Array.isArray(it.roles) && it.roles.map((r) => (
                    <span key={r} className="report-tag">면접관 {r}</span>
                  ))}
                  {/* {it.rounds ? <span className="report-tag">라운드 {it.rounds}</span> : null} */}
                  {it.durationSec ? <span className="report-tag">{secToMin(it.durationSec)}</span> : null}
                </div>

                {/* 하단: 날짜 */}
                <div className="report-card-foot">
                  <span className="report-date">{fmtDateOnly(it.createdAt)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 페이지 네비게이션 */}
      {showPager && (
        <nav className="report-pager" aria-label="페이지 이동">
          <button
            className="pager-btn"
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            disabled={!canPrev}
            aria-label="이전 페이지"
          >
            ‹
          </button>

          {Array.from({ length: knownPages }).map((_, i) => {
            const loaded = i < pages.length;
            const active = i === pageIndex;
            return (
              <button
                key={i}
                className={`pager-num ${active ? 'is-active' : ''} ${!loaded ? 'is-ghost' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (loaded) {
                    setPageIndex(i);
                  } else if (lastPage?.nextCursor && !loading) {
                    loadNextPage();
                  }
                }}
                disabled={!loaded && loading}
              >
                {i + 1}
              </button>
            );
          })}

          <button
            className="pager-btn"
            onClick={() => {
              if (pageIndex < pages.length - 1) {
                setPageIndex(pageIndex + 1);
              } else if (lastPage?.nextCursor && !loading) {
                loadNextPage();
              }
            }}
            disabled={!canNext || loading}
            aria-label="다음 페이지"
          >
            ›
          </button>
        </nav>
      )}
    </div>
  );
}

/* ---------- helpers ---------- */
function normalize(arr) {
  return arr.map((x) => {
    const id = x.id || x._id || x.sessionId || x.session_id;
    const createdAt = x.createdAt || x.created_at || x.startedAt || x.startTime || x.date;
    return {
      id: String(id),
      title: x.title || x.sessionTitle || '',
      summary: x.summary || x.overview || x.snippet || '',
      score: typeof x.score === 'number' ? x.score : (typeof x.totalScore === 'number' ? x.totalScore : undefined),
      roles: x.roles || x.interviewers || x.interviewerRoles || [],
      rounds: x.rounds || x.roundCount,
      durationSec: x.durationSec || x.duration || x.seconds,
      username: x.username || x.userName || x.name || '',
      jobRole: x.jobRole || x.position || x.role || '',
      createdAt,
    };
  }).filter((x) => !!x.id);
}

function fmtDateOnly(v) {
  if (!v) return '';
  const d = new Date(v);
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(d);
  } catch {
    return d.toLocaleDateString('ko-KR');
  }
}

function secToMin(sec) {
  const s = Number(sec) || 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}분 ${r}초`;
}

function parseServerError(txt) {
  if (!txt) return '';
  try {
    const j = JSON.parse(txt);
    return j.message || j.error || '';
  } catch {
    return txt;
  }
}
