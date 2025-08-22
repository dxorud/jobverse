const axios = require('axios');

const {
  DIFY_API_URL,  
  DIFY_API_KEY,   
  CHATFLOW_ID,    
} = process.env;

const BASE = (DIFY_API_URL || '').replace(/\/+$/, '');
if (!BASE) throw new Error('DIFY_API_URL is not set');

function authHeaders(key) {
  if (!key) throw new Error('Dify API key is missing (chatbot)');
  return { Authorization: `Bearer ${key}` };
}

/** 일반 Chat App 호출 */
async function postChatMessages({ apiKey, query, inputs = {}, user = 'anonymous', stream = false }) {
  const { data } = await axios.post(
    `${BASE}/chat-messages`,
    { response_mode: stream ? 'streaming' : 'blocking', query, inputs },
    { headers: authHeaders(apiKey), timeout: 30_000 }
  );
  return data;
}

/** 워크플로우 실행 (CHATFLOW_ID 있을 때) */
async function runWorkflow({ apiKey, workflowId, inputs = {}, user = 'anonymous', stream = false }) {
  const { data } = await axios.post(
    `${BASE}/workflows/run`,
    { workflow_id: workflowId, inputs, response_mode: stream ? 'streaming' : 'blocking', user },
    { headers: authHeaders(apiKey), timeout: 60_000 }
  );
  return data;
}

/** ai.js의 askDifyApp 대체: 문자열 answer 반환 */
async function askDifyApp({ input, variables, user = 'anonymous', stream = false }) {
  if (!DIFY_API_KEY) throw new Error('DIFY_API_KEY is not set');

  // CHATFLOW_ID가 있으면 우선 워크플로우로
  if (CHATFLOW_ID) {
    const data = await runWorkflow({
      apiKey: DIFY_API_KEY,
      workflowId: CHATFLOW_ID,
      inputs: { query: input || '', ...(variables || {}) },
      user,
      stream,
    });

    const answer =
      data?.answer ??
      data?.data?.outputs?.answer ??
      data?.data?.output_text ??
      data?.outputs?.answer ??
      '';
    return String(answer || '').trim();
  }

  // 일반 Chat App
  const data = await postChatMessages({
    apiKey: DIFY_API_KEY,
    query: input || '',
    inputs: variables || {},
    user,
    stream,
  });

  return String(data?.answer || '').trim();
}

module.exports = { askDifyApp, postChatMessages, runWorkflow };
