/**
 * 정부 R&D 사업 AI 매니저 — Cloudflare Worker (Workers AI 무료 티어 사용)
 *
 * 역할:
 *  - 브라우저(rnd_manager 앱)에서 회사 정보 + 사업공고 원문(또는 선택한 과제 아이디어)을 받아
 *  - Cloudflare Workers AI(무료 티어, 하루 10,000 뉴런, 신용카드 불필요)를 호출해서
 *    ① 공고문 분석(적합도/사업비/마감일/컨소시엄 필요 여부/대학 참여 가능 여부/과제 아이디어)
 *    ② 사업계획서 목차 생성
 *    을 구조화된 JSON으로 돌려준다.
 *
 * 상용 API 키가 전혀 필요 없다 — Cloudflare 계정에 AI 바인딩만 걸어두면 끝.
 *
 * 배포:
 *   cd worker-rnd-manager
 *   wrangler deploy
 *
 * 배포 후 받는 주소(예: https://rnd-manager-ai.<계정>.workers.dev)를
 * rnd_manager 앱의 "Worker 주소" 설정란에 붙여넣으면 된다.
 */

const ALLOWED_ORIGINS = [];

function corsHeaders(origin) {
  const allowOrigin =
    ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)
      ? (origin || "*")
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// ---------- 1) 공고문 분석 ----------

const ANALYZE_SYSTEM_PROMPT = `너는 대한민국 정부 R&D(연구개발) 지원사업 전문 컨설턴트다.
사용자가 자기 회사의 정보와, 특정 정부 R&D 사업공고의 원문(또는 요약)을 함께 준다.

너의 역할:
1. 이 회사가 해당 공고에 지원할 만한지(fit_level: "높음"/"보통"/"낮음") 판단하고, 그 이유를 2~4개 이유(fit_reasons)로 제시한다.
2. 공고문에서 사업비 규모(budget_max_text, 예: "최대 5억원", 못 찾으면 "확인불가"), 마감일(deadline_text, 예: "2026-09-30" 형식 또는 원문 그대로, 못 찾으면 "확인불가")을 추출한다.
3. 컨소시엄(공동연구/공동사업자) 구성이 필요한지(consortium_required: "필요"/"불필요"/"확인불가"), 대학이나 연구기관 참여가 가능한지(university_allowed: "가능"/"불가"/"확인불가")를 판단한다.
4. 공고 내용을 2~3문장으로 요약(summary)한다.
5. 이 회사의 보유기술/업종을 고려했을 때 이 공고에 지원할 만한 구체적인 과제 아이디어를 3개(idea_suggestions) 제안한다. 각 아이디어는 제목(title)과 1~2문장 설명(description)을 갖는다.

규칙:
- 공고문에 명시되지 않은 내용을 함부로 지어내지 말고, 확실하지 않으면 "확인불가"라고 써라. 단, 과제 아이디어(idea_suggestions)는 회사의 보유기술을 바탕으로 창의적으로 제안해도 된다.
- 오직 지정된 JSON 객체 하나만 응답으로 출력해라. 응답의 첫 글자는 반드시 { 여야 한다. 코드, 설명 문장, 마크다운을 절대 포함하지 마라.`;

const ANALYZE_JSON_SCHEMA = {
  type: "object",
  properties: {
    fit_level: { type: "string", enum: ["높음", "보통", "낮음"] },
    fit_reasons: { type: "array", items: { type: "string" } },
    budget_max_text: { type: "string" },
    deadline_text: { type: "string" },
    consortium_required: { type: "string", enum: ["필요", "불필요", "확인불가"] },
    university_allowed: { type: "string", enum: ["가능", "불가", "확인불가"] },
    summary: { type: "string" },
    idea_suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
      },
    },
  },
  required: [
    "fit_level",
    "fit_reasons",
    "budget_max_text",
    "deadline_text",
    "consortium_required",
    "university_allowed",
    "summary",
    "idea_suggestions",
  ],
};

function buildAnalyzeUserPrompt(payload) {
  const { company, announcementText, announcementTitle } = payload;
  return JSON.stringify({
    회사정보: company,
    공고제목: announcementTitle || "",
    공고원문: (announcementText || "").slice(0, 6000),
  });
}

// ---------- 2) 사업계획서 목차 생성 ----------

const OUTLINE_SYSTEM_PROMPT = `너는 대한민국 정부 R&D 지원사업 사업계획서 작성 컨설턴트다.
사용자가 회사 정보, 지원하려는 공고 정보(제목/요약), 그리고 선택한 과제 아이디어를 준다.

너의 역할: 이 과제로 제출할 사업계획서의 목차(outline)를 만드는 것이다.
정부 R&D 사업계획서의 일반적인 구성(사업 개요, 필요성, 목표 및 개발 내용, 추진 전략/방법, 수행 일정, 기대효과 및 활용방안, 참여 인력, 예산 계획 등)을 참고해서
8~12개의 목차 항목(section)을 만들고, 각 항목마다 그 항목에 무엇을 써야 하는지 1~2문장 가이드(guide)를 붙인다.

규칙:
- 실제 이 회사와 이 과제 아이디어에 맞춰 구체적으로 작성해라 (일반론만 나열하지 마라).
- 오직 지정된 JSON 객체 하나만 응답으로 출력해라. 응답의 첫 글자는 반드시 { 여야 한다. 코드, 설명 문장, 마크다운을 절대 포함하지 마라.`;

const OUTLINE_JSON_SCHEMA = {
  type: "object",
  properties: {
    outline: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string" },
          guide: { type: "string" },
        },
        required: ["section", "guide"],
      },
    },
  },
  required: ["outline"],
};

function buildOutlineUserPrompt(payload) {
  const { company, announcementTitle, announcementSummary, idea } = payload;
  return JSON.stringify({
    회사정보: company,
    공고제목: announcementTitle || "",
    공고요약: announcementSummary || "",
    선택한_과제_아이디어: idea || "",
  });
}

// 모델이 JSON 앞뒤로 설명 문장이나 코드펜스를 섞어 보내는 경우가 많아,
// 앞뒤 텍스트가 뭐든 상관없이 첫 '{'부터 마지막 '}'까지만 잘라내 파싱한다.
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("응답에서 JSON 객체를 찾지 못함");
  }
  const candidate = text.slice(start, end + 1);
  return JSON.parse(candidate);
}

async function runAI(env, systemPrompt, userPrompt, jsonSchema) {
  const aiResponse = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 4096,
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    },
  });

  if (aiResponse && typeof aiResponse.response === "object" && aiResponse.response !== null) {
    return aiResponse.response;
  }
  const rawText = (aiResponse && aiResponse.response) || "";
  return extractJson(rawText);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST만 지원합니다." }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "잘못된 JSON 요청입니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (!env.AI) {
      return new Response(
        JSON.stringify({ error: "이 Worker에 AI 바인딩이 설정되어 있지 않습니다. wrangler.toml의 [ai] 설정을 확인하세요." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    const action = payload && payload.action;

    try {
      if (action === "analyze") {
        if (!payload.announcementText || !payload.company) {
          return new Response(JSON.stringify({ error: "company, announcementText가 필요합니다." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
        const result = await runAI(env, ANALYZE_SYSTEM_PROMPT, buildAnalyzeUserPrompt(payload), ANALYZE_JSON_SCHEMA);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      if (action === "outline") {
        if (!payload.company || !payload.idea) {
          return new Response(JSON.stringify({ error: "company, idea가 필요합니다." }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
        const result = await runAI(env, OUTLINE_SYSTEM_PROMPT, buildOutlineUserPrompt(payload), OUTLINE_JSON_SCHEMA);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      return new Response(JSON.stringify({ error: "action은 'analyze' 또는 'outline'이어야 합니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Workers AI 호출/파싱 실패", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};
