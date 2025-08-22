// services/elevenlabs.js
const axios = require('axios');
const FormData = require('form-data');

const {
  ELEVEN_API_KEY,
  VOICE_ID_A,
  VOICE_ID_B,
  VOICE_ID_C,
  VOICE_ID_DEFAULT,
  ELEVEN_TTS_MODEL,
  ELEVEN_STT_MODEL,
} = process.env;

/** 역할(면접관)별 보이스 ID 결정 */
function resolveVoiceId(role = 'DEFAULT') {
  const r = String(role).toUpperCase();
  const map = {
    A: VOICE_ID_A,
    B: VOICE_ID_B,
    C: VOICE_ID_C,
    DEFAULT: VOICE_ID_DEFAULT || VOICE_ID_A || VOICE_ID_B || VOICE_ID_C,
  };
  const id = map[r] || map.DEFAULT;
  if (!id) throw new Error(`No voice id configured for role: ${role}`);
  return id;
}

/** Text → Speech (Buffer 반환) */
async function textToSpeech(text, role = 'DEFAULT', opts = {}) {
  if (!ELEVEN_API_KEY) throw new Error('ELEVEN_API_KEY is not set');
  if (!text || !text.trim()) throw new Error('TTS text is empty');

  const voiceId = resolveVoiceId(role);
  const model = ELEVEN_TTS_MODEL || 'eleven_multilingual_v2';

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        text,
        model_id: model,
        voice_settings: {
          stability: opts.stability ?? 0.5,
          similarity_boost: opts.similarity_boost ?? 0.8,
          style: opts.style,
          use_speaker_boost: opts.use_speaker_boost ?? true,
        },
      },
      {
        headers: {
          'xi-api-key': ELEVEN_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 30_000,
      }
    );
    return res.data; // audio buffer
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('TTS error:', msg);
    throw new Error(`TTS failed: ${err.response?.status || ''} ${JSON.stringify(msg)}`);
  }
}

/** Speech → Text (string 반환) */
async function speechToText(buffer, filename = 'audio.webm', contentType = 'audio/webm') {
  if (!ELEVEN_API_KEY) throw new Error('ELEVEN_API_KEY is not set');
  if (!buffer || !buffer.length) throw new Error('STT buffer is empty');

  const form = new FormData();
  form.append('file', buffer, { filename, contentType });
  form.append('model_id', ELEVEN_STT_MODEL || 'scribe_v1');

  try {
    const res = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', form, {
      headers: { 'xi-api-key': ELEVEN_API_KEY, ...form.getHeaders() },
      timeout: 60_000,
    });
    return res.data?.text || '';
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('STT error:', msg);
    throw new Error(`STT failed: ${err.response?.status || ''} ${JSON.stringify(msg)}`);
  }
}

module.exports = { resolveVoiceId, textToSpeech, speechToText };
