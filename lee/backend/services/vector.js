const weaviate = require('weaviate-ts-client').default;

const host = process.env.WEAVIATE_HOST || 'http://localhost:8080';
const EMB_MODEL = process.env.TEXT2VEC_OPENAI_MODEL || 'text-embedding-3-small';

// 클래스명 환경변수로 오버라이드 가능 (선택)
const CLASS_Q = process.env.WEAVIATE_CLASS_Q || 'QuestionChunk';
const CLASS_A = process.env.WEAVIATE_CLASS_A || 'AnswerChunk';
const CLASS_R = process.env.WEAVIATE_CLASS_R || 'InterviewQA';

// Weaviate client
const client = weaviate.client({
  scheme: host.startsWith('https') ? 'https' : 'http',
  host: host.replace(/^https?:\/\//, ''),
  headers: process.env.OPENAI_API_KEY
    ? { 'X-OpenAI-Api-Key': process.env.OPENAI_API_KEY } // text2vec-openai에서 OpenAI 호출용
    : undefined,
});

// 스키마 생성 헬퍼
function classDef(name, props) {
  return {
    class: name,
    vectorizer: 'text2vec-openai',
    moduleConfig: {
      'text2vec-openai': { model: EMB_MODEL },
    },
    vectorIndexConfig: {
      distance: 'cosine', // similarity = 1 - distance (cosine)
    },
    properties: props.map((p) => {
      // 긴 텍스트는 text 타입으로
      if (p === 'text' || p === 'content') return { name: p, dataType: ['text'] };
      if (p === 'turn') return { name: 'turn', dataType: ['int'] };
      // 그 외는 string
      return { name: p, dataType: ['string'] };
    }),
  };
}

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;

  const res = await client.schema.getter().do();
  const existing = new Map((res.classes || []).map((c) => [c.class, c]));

  const defs = [
    // 면접 질문/답 파편
    classDef(CLASS_Q, [
      'text', 'sessionId', 'userName', 'userId', 'userEmail',
      'jobRole', 'turn', 'mongoMessageId', 'interviewerRole',
    ]),
    classDef(CLASS_A, [
      'text', 'sessionId', 'userName', 'userId', 'userEmail',
      'jobRole', 'turn', 'mongoMessageId',
    ]),
    // 리포트(요약/QA 통합 검색용)
    classDef(CLASS_R, [
      'content', 'section', // section: 'summary' | 'qa'
      'sessionId', 'name', 'role', 'date',
      'turn', // qa 순서/번호 보존용
    ]),
  ];

  for (const def of defs) {
    const cur = existing.get(def.class);
    if (!cur) {
      await client.schema.classCreator().withClass(def).do();
      continue;
    }
    // 누락 속성만 추가
    const have = new Set((cur.properties || []).map((p) => p.name));
    for (const prop of def.properties) {
      if (!have.has(prop.name)) {
        await client.schema
          .propertyCreator()
          .withClassName(def.class)
          .withProperty(prop)
          .do();
      }
    }
  }

  schemaReady = true;
}

// 단건 upsert (QuestionChunk/AnswerChunk 등에서 사용 가능)
async function upsert(className, props) {
  await ensureSchema();
  return client.data.creator().withClassName(className).withProperties(props).do();
}

// 세션 단위(리포트) 업서트: summary + qa들을 InterviewQA에 저장
async function upsertForSession(sessionId, report) {
  await ensureSchema();

  // 기존 자료 제거(같은 세션의 리포트 문서들)
  await deleteBySessionId(sessionId).catch(() => {});

  const objects = [];

  const base = {
    sessionId: String(sessionId),
    name: report?.name || '',
    role: report?.role || '',
    date: report?.date || '',
  };

  // 요약/강점/개선/추천을 한 문서로 통합 저장하면 검색 품질이 좋아짐
  const summaryParts = [];
  if (report?.overview) summaryParts.push(`[요약] ${report.overview}`);
  if (Array.isArray(report?.strengths) && report.strengths.length) {
    summaryParts.push(`[강점] ${report.strengths.join(' • ')}`);
  }
  if (Array.isArray(report?.areas) && report.areas.length) {
    summaryParts.push(`[개선] ${report.areas.join(' • ')}`);
  }
  if (report?.recommendation) summaryParts.push(`[제안] ${report.recommendation}`);

  if (summaryParts.length) {
    objects.push({
      class: CLASS_R,
      properties: {
        ...base,
        section: 'summary',
        content: summaryParts.join('\n'),
        turn: 0,
      },
    });
  }

  // Q/A 각각 저장 (검색 recall 향상)
  if (Array.isArray(report?.qa)) {
    report.qa.forEach((qa, idx) => {
      const content = [
        qa.question ? `[Q] ${qa.question}` : '',
        qa.answer ? `[A] ${qa.answer}` : '',
        qa.analysis ? `[분석] ${qa.analysis}` : '',
        qa.tips ? `[팁] ${qa.tips}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (content) {
        objects.push({
          class: CLASS_R,
          properties: {
            ...base,
            section: 'qa',
            content,
            turn: idx + 1,
          },
        });
      }
    });
  }

  if (!objects.length) return;

  // 배치 업서트
  await client.batch.objectsBatcher().withObjects(objects).do();
}

// 세션 단위 삭제: InterviewQA + (선택) Q/A 조각도 함께 정리
async function deleteBySessionId(sessionId) {
  await ensureSchema();

  const where = (path) => ({
    path: [path],
    operator: 'Equal',
    valueString: String(sessionId),
  });

  // InterviewQA
  await client.batch
    .objectsBatchDeleter()
    .withClassName(CLASS_R)
    .withWhere(where('sessionId'))
    .do();

  // (선택) QuestionChunk / AnswerChunk도 같이 지우고 싶다면 해제
  // await client.batch
  //   .objectsBatchDeleter()
  //   .withClassName(CLASS_Q)
  //   .withWhere(where('sessionId'))
  //   .do();
  // await client.batch
  //   .objectsBatchDeleter()
  //   .withClassName(CLASS_A)
  //   .withWhere(where('sessionId'))
  //   .do();
}

// 유사 질문 탐색 (세션/직무/사용자 범위 내)
async function findSimilarQuestions({
  text,
  sessionId,
  userName,
  userId,
  userEmail,
  jobRole,
  limit = 5,
}) {
  await ensureSchema();

  const operands = [
    { path: ['sessionId'], operator: 'Equal', valueString: String(sessionId) },
    { path: ['jobRole'], operator: 'Equal', valueString: jobRole },
  ];

  if (userId) {
    operands.push({ path: ['userId'], operator: 'Equal', valueString: String(userId) });
  } else if (userEmail) {
    operands.push({ path: ['userEmail'], operator: 'Equal', valueString: userEmail });
  } else if (userName) {
    operands.push({ path: ['userName'], operator: 'Equal', valueString: userName });
  }

  const r = await client.graphql
    .get()
    .withClassName(CLASS_Q)
    .withFields('text turn _additional { distance }')
    .withNearText({ concepts: [text] })
    .withWhere({ operator: 'And', operands })
    .withLimit(limit)
    .do();

  const items = r?.data?.Get?.[CLASS_Q] || [];
  return items.map((i) => ({
    text: i.text,
    turn: i.turn,
    distance: i?._additional?.distance,
    similarity: typeof i?._additional?.distance === 'number'
      ? 1 - i._additional.distance
      : null,
  }));
}

module.exports = {
  ensureSchema,
  upsert,
  upsertForSession,
  deleteBySessionId,
  findSimilarQuestions,
};
