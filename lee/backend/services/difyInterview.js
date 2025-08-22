const axios = require('axios');

const {
  DIFY_API_URL,
  DIFY_AGENT_A_API_KEY,
  DIFY_AGENT_B_API_KEY,
  DIFY_AGENT_C_API_KEY,
} = process.env;

const BASE = (DIFY_API_URL || '').replace(/\/+$/, '');
if (!BASE) throw new Error('DIFY_API_URL is not set');

const AGENT_KEYS = {
  A: DIFY_AGENT_A_API_KEY,
  B: DIFY_AGENT_B_API_KEY,
  C: DIFY_AGENT_C_API_KEY,
};

function pickAgent(key = 'A') {
  const apiKey = AGENT_KEYS[String(key).toUpperCase()];
  if (!apiKey) throw new Error(`Interview agent key is missing for: ${key}`);
  return apiKey;
}

async function postChat({ apiKey, query, inputs = {}, user = 'interviewee', stream = false }) {
  const { data } = await axios.post(
    `${BASE}/chat-messages`,
    { response_mode: stream ? 'streaming' : 'blocking', query, inputs },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30_000 }
  );
  return data;
}

/** ai.js의 askAgentByRole 대체: 문자열 answer 반환 */
async function askAgentByRole(role, { input, variables, user = 'interviewee', stream = false }) {
  const apiKey = pickAgent(role);
  const data = await postChat({
    apiKey,
    query: input || '',
    inputs: variables || {},
    user,
    stream,
  });
  return String(data?.answer || '').trim();
}

module.exports = { askAgentByRole, pickAgent, postChat };
