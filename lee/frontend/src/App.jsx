import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Interview from './components/Interview.jsx';
import Chatbot from './components/Chatbot.jsx';
import Report from './components/Report.jsx';
import ReportPages from './components/ReportPage.jsx';

export default function App() {
  const basename = import.meta.env.DEV ? '/' : '/interview';
  const apiPrefix = '/interview-api';
  const authHeaders = {}; 

  return (
    <BrowserRouter basename={basename}>
      <Routes>
        {/* 루트는 바로 인터뷰 페이지 */}
        <Route index element={<Interview />} />

        {/* /interview 도 동일 페이지로 열리게 */}
        <Route path="interview" element={<Interview />} />

        <Route path="chat" element={<Chatbot />} />

        {/* 리포트 목록: 백엔드 프록시 경로로 호출 */}
        <Route
          path="report"
          element={
            <Report
              listPath={`${apiPrefix}/reports`}
              authHeaders={authHeaders}
            />
          }
        />

        {/* 리포트 상세 */}
        <Route
          path="report/:id"
          element={
            <ReportPages
              // baseUrl 생략 가능(기본값: VITE_API_BASE || '')
              baseUrl=""
              authHeaders={authHeaders}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
