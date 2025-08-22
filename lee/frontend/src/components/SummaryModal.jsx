import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './SummaryModal.css';

export default function SummaryModal({
  open = false,
  sessionId,
  onClose,
  onMore,
  moreTo = '/report',
  baseUrl = '',
  authHeaders
}) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState('');
  const [bullets, setBullets] = useState([]);
  const [error, setError] = useState('');

  const navigate = useNavigate();
  const boxRef = useRef(null);
  const firstBtnRef = useRef(null);
  const lastBtnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => boxRef.current?.focus?.());
  }, [open]);

  useEffect(() => {
    if (!open || !sessionId) return;

    const ctrl = new AbortController();
    const { signal } = ctrl;

    setLoading(true);
    setError('');
    setSummary('');
    setBullets([]);

    const apiBase = (baseUrl || '').replace(/\/+$/, '');
    const url = `${apiBase}/summary/${encodeURIComponent(sessionId)}`;

    fetch(url, { headers: { ...(authHeaders || {}) }, signal })
      .then(async (r) => {
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          throw new Error(txt || `요약 API 실패 (HTTP ${r.status})`);
        }
        return r.json();
      })
      .then((d) => {
        setSummary(d.summary || '');
        setBullets(Array.isArray(d.bullets) ? d.bullets : []);
      })
      .catch((e) => {
        if (signal.aborted) return;
        setError(e?.message || '요약을 불러오지 못했어요.');
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });

    return () => ctrl.abort();
  }, [open, sessionId, baseUrl, authHeaders]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onKeyDownTrap = (e) => {
    if (e.key !== 'Tab') return;
    const first = firstBtnRef.current;
    const last = lastBtnRef.current;
    if (!first || !last) return;

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // (유틸) '/report' 형태 보장
  const ensurePath = (p) => (p?.startsWith('/') ? p : `/${p || ''}`);

  // ✅ 더 알아보기: 목록 페이지로 이동 + sessionId state 전달 + 폴백
  const handleMore = (e) => {
    e?.preventDefault?.();
    if (loading) return;

    const target = ensurePath(moreTo || '/report');

    try {
      if (typeof onMore === 'function') onMore();
    } catch {
      // onMore 내부 에러는 네비게이션을 막지 않음
    }

    try {
      navigate(target, { state: { from: 'summary', sessionId } });
    } catch {
      // 라우터 컨텍스트 밖(포털/별도 루트)일 때 하드 네비게이션
      window.location.href = target;
    }

    onClose?.();
  };

  // ⌨️ 모달 안에서 Enter 누르면(버튼/입력요소 제외) 더 알아보기 실행
  const handleKeyDown = (e) => {
    onKeyDownTrap(e);
    if (e.key === 'Enter' && !loading && !error) {
      const tag = (e.target.tagName || '').toLowerCase();
      const interactive = ['a', 'button', 'input', 'textarea', 'select'];
      if (!interactive.includes(tag)) {
        handleMore(e);
      }
    }
  };

  return (
    <div
      className="summary-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="summary-title"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        className="summary-box"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        aria-busy={loading ? 'true' : 'false'}
      >
        {/* 헤더 */}
        <div className="summary-header">
          <span className="summary-emoji" aria-hidden>📝</span>
          <h2 id="summary-title" className="summary-title">짧은 분석</h2>
        </div>

        {/* 본문 */}
        <div className="summary-body">
          {loading && <p className="summary-loading">분석 중이에요…</p>}
          {!loading && error && <p className="summary-error">{error}</p>}

          {!loading && !error && (
            <>
              {!!summary && <p className="summary-text">{summary}</p>}
              {!!bullets.length && (
                <ul className="summary-list">
                  {bullets.map((b, i) => (
                    <li key={i} className="summary-list-item">{b}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* 액션 */}
        <div className="summary-actions">
          <button
            type="button"
            className="summary-btn"
            onClick={onClose}
            ref={firstBtnRef}
          >
            닫기
          </button>

          <button
            type="button"
            className="summary-btn summary-btn--primary"
            onClick={handleMore}
            disabled={loading}
            title={loading ? '분석 중입니다' : undefined}
            ref={lastBtnRef}
          >
            더 알아보기
          </button>
        </div>
      </div>
    </div>
  );
}
