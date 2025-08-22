import React, { useState, useRef } from 'react';
import './Interview.css';
import Modal from './Modal';
import EndModal from './EndModal';
import SummaryModal from './SummaryModal';
import interviewerA from '../assets/interviewerA.png';
import interviewerB from '../assets/interviewerB.png';
import interviewerC from '../assets/interviewerC.png';
import userProfile from '../assets/user.png';

const Interview = () => {
  const [showModal, setShowModal] = useState(true);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [username, setUsername] = useState('');
  const [jobRole, setJobRole] = useState('');
  const [input, setInput] = useState('');
  const [chat, setChat] = useState([]);
  const [currentInterviewer, setCurrentInterviewer] = useState(null);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [round, setRound] = useState(0);
  const [firstAnswer, setFirstAnswer] = useState('');
  const [sessionId, setSessionId] = useState(null);

  /* ===================== API BASE ===================== */
  const INTERVIEW_API_BASE = import.meta.env.VITE_INTERVIEW_API_BASE || '/interview-api';

  const interviewerIds = ['C', 'A', 'B'];
  const prevInterviewerRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);
  const ttsQueue = useRef([]);
  const isSpeaking = useRef(false);

  const interviewerInfo = {
    A: { name: '인사팀', image: interviewerA },
    B: { name: '기술팀', image: interviewerB },
    C: { name: '실무 팀장', image: interviewerC },
  };

  const getRandomInterviewer = () => {
    const filtered = interviewerIds.filter(id => id !== prevInterviewerRef.current);
    const selected = filtered[Math.floor(Math.random() * filtered.length)];
    prevInterviewerRef.current = selected;
    return selected;
  };

  const getHeader = (res, name) =>
    res.headers.get(name) ||
    res.headers.get(name.toLowerCase()) ||
    res.headers.get(name.toUpperCase()) ||
    null;

  const safeFetch = async (url, options) => {
    const res = await fetch(url, options);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} on ${url}${t ? ` - ${t}` : ''}`);
    }
    return res;
  };

  const playNextInQueue = async () => {
    if (isSpeaking.current || ttsQueue.current.length === 0) return;
    const { text, role } = ttsQueue.current.shift();
    isSpeaking.current = true;
    try {
      const res = await safeFetch(`${INTERVIEW_API_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, role })
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }

      audioRef.current = audio;
      audio.onended = () => {
        isSpeaking.current = false;
        playNextInQueue();
      };

      audio.play().catch(() => {});
    } catch (_err) {
      isSpeaking.current = false;
    }
  };

  const streamChatResponse = async (payload) => {
    try {
      const res = await safeFetch(`${INTERVIEW_API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.body) throw new Error('응답 스트림 없음');

      const interviewerHeader = getHeader(res, 'interviewer');
      const endHeader = getHeader(res, 'X-Interview-Ended');
      const preEnded = endHeader === '1';

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let buffer = '';
      let fullText = '';
      let sentenceBuffer = '';
      let endedByServer = preEnded;

      if (interviewerHeader && !endedByServer) {
        setCurrentInterviewer(interviewerHeader);
        setChat(prev => [...prev, { sender: interviewerHeader, text: '' }]);
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const content = line.replace(/^data:\s*/, '').trim();
          if (content === '[DONE]') break;

          let delta = '';
          try {
            const json = JSON.parse(content);
            delta = json.answer || '';
          } catch { /* ignore */ }

          if (/면접이 종료되었습니다/.test(delta)) endedByServer = true;
          if (!interviewerHeader || endedByServer) break;

          fullText += delta;
          sentenceBuffer += delta;

          setChat(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.sender === interviewerHeader) {
              updated[updated.length - 1] = { ...last, text: (last.text || '') + delta };
            }
            return updated;
          });

          if (/[.!?…]\s?$/.test(sentenceBuffer)) {
            ttsQueue.current.push({ text: sentenceBuffer.trim(), role: interviewerHeader });
            sentenceBuffer = '';
            playNextInQueue();
          }
        }

        if (endedByServer) break;
      }

      if (!endedByServer && interviewerHeader && sentenceBuffer.trim()) {
        ttsQueue.current.push({ text: sentenceBuffer.trim(), role: interviewerHeader });
        playNextInQueue();
      }

      return { ended: endedByServer, text: fullText };
    } catch (_err) {
      return { ended: false, text: '' };
    }
  };

  const pickFirstInterviewer = async (nameParam, jobParam) => {
    const name = nameParam ?? username;
    const role = jobParam ?? jobRole;

    const res = await safeFetch(`${INTERVIEW_API_BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: name, jobRole: role })
    });
    const data = await res.json();

    setSessionId(data.sessionId);
    const interviewerKey =
      getHeader(res, 'interviewer') ||
      data.interviewer ||
      getRandomInterviewer();
    setCurrentInterviewer(interviewerKey);

    const { question } = data;
    setChat([{ sender: interviewerKey, text: question }]);
    ttsQueue.current.push({ text: question, role: interviewerKey });
    playNextInQueue();

    setRound(1);
  };

  const handleUserSubmit = async () => {
    if (!input.trim()) return;

    const userText = input.trim();
    setChat(prev => [...prev, { sender: 'user', text: userText }]);
    setInput('');

    if (round === 1) setFirstAnswer(userText);

    if (!sessionId) {
      return;
    }

    const { ended } = await streamChatResponse({
      sessionId,
      jobRole,
      message: userText,
      userName: username
    });

    if (ended) {
      setShowEndModal(true);
      return;
    }

    setRound(prev => prev + 1);
  };

  const handleStartRecording = async () => {
    if (isRecording && mediaRecorder) {
      mediaRecorder.stop();
      setIsRecording(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    setMediaRecorder(recorder);
    audioChunksRef.current = [];
    setIsRecording(true);

    recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');
      formData.append('user', username);

      try {
        const res = await safeFetch(`${INTERVIEW_API_BASE}/stt`, {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.text) setInput(data.text);
      } catch (_err) {
        // no-op
      }
    };

    recorder.start();
  };

  const handleNameSubmit = (name, job) => {
    setUsername(name);
    setJobRole(job);
    setShowModal(false);
    pickFirstInterviewer(name, job);
  };

  const handleInterviewEnd = () => {
    setShowEndModal(false);
    window.location.href = '/';
  };

  const handleQuickSummary = () => {
    setShowEndModal(false);
    setShowSummary(true);
  };

  return (
    <div className="interview-fullscreen">
      {showModal && <Modal onSubmit={handleNameSubmit} />}

      {showEndModal && (
        <EndModal
          open={showEndModal}
          onClose={handleInterviewEnd}
          onQuick={handleQuickSummary}
        />
      )}

      <SummaryModal
        open={showSummary}
        sessionId={sessionId}
        onClose={() => setShowSummary(false)}
        onMore={() => {}}
        baseUrl={INTERVIEW_API_BASE} 
      />

      <div className="interviewers">
        {['C','A','B'].map((id) => (
          <div key={id} className={`interviewer-card ${currentInterviewer === id ? 'active' : ''}`}>
            <img src={interviewerInfo[id].image} alt={interviewerInfo[id].name} />
            <p>{interviewerInfo[id].name}</p>
          </div>
        ))}
      </div>

      <div className="question-display">
        {chat
          .filter(msg => msg.sender !== 'user')
          .slice(-1)
          .map((msg, idx) => (
            <div key={idx} className="question-msg">
              <strong>{interviewerInfo[msg.sender]?.name}:</strong> {msg.text}
            </div>
          ))}
      </div>

      <div className="user-bottom">
        <img src={userProfile} alt="지원자" className="user-card" />
        <div className="user-input-box">
          <input
            type="text"
            placeholder="답변을 입력하세요"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUserSubmit()}
          />
        <button onClick={handleStartRecording}>{isRecording ? '🛑' : '🎤'}</button>
          <button onClick={handleUserSubmit}>📤</button>
        </div>
      </div>
    </div>
  );
};

export default Interview;
