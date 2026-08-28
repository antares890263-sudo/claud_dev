/**
 * GPX 트레일런 페이스 플래너 — Cloudflare Worker (Workers AI 무료 티어 사용)
 *
 * 역할:
 *  - 브라우저에서 온 요청(구간별 거리/경사/고도 + 사용자의 목표/컨디션)을 받아
 *  - Cloudflare Workers AI(무료 티어, 하루 10,000 뉴런, 신용카드 불필요)를 호출해서
 *    구간별 목표 페이스를 구조화된 JSON으로 받아오고
 *  - 결과를 다시 브라우저로 돌려준다.
 *
 * 상용 API 키가 전혀 필요 없다 — Cloudflare 계정에 AI 바인딩만 걸어두면 끝.
 *
 * 배포:
 *   wrangler deploy
 *
 * (Anthropic API 키 등록 같은 별도 시크릿 설정이 필요 없습니다.)
 * 배포 후 받는 주소(예: https://gpx-pace-planner.<계정>.workers.dev)를
 * 트래커 앱의 "Worker 주소" 설정란에 붙여넣으면 된다.
 */

// 이 배열에 실제로 앱을 배포한 도메인을 넣어두면 그 출처에서 온 요청만 허용된다.
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

// 무료 티어에서 가볍고 안정적으로 도는 instruct 모델.
// 더 강한 모델이 필요하면 '@cf/meta/llama-3.1-70b-instruct' 등으로 바꿀 수 있지만
// 뉴런 소모가 커져서 하루 무료 한도를 더 빨리 씀.
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const SYSTEM_PROMPT = `너는 트레일 러닝 페이스 코치다. 사용자가 업로드한 GPX 코스를 구간으로 나눈 데이터를 받는데,
각 구간의 거리·경사·이미 계산된 목표 페이스·목표 통과시간이 전부 함께 주어진다 (이 숫자들은 이미 정확하게 계산되어 있으니 절대 다시 계산하거나 바꾸지 마라).

너의 역할은 딱 하나, 각 구간마다 한 줄짜리 코칭 코멘트(note)를 쓰는 것이다. 예:
- 오르막이 심한 구간이면 "여기서 오버페이스하지 말고 걷기 섞어서 가세요"
- 완만한 구간이면 "리듬 유지하며 페이스대로"
- 급한 내리막이면 "무릎 부담 주의, 보폭 짧게"
- 사용자가 적은 컨디션/메모(예: 무릎이 약함, 초보 등)가 있으면 관련 구간에서 반영해라.

규칙:
- 절대로 코드(Python 등)를 작성하지 마라. 절대로 숫자를 계산하는 풀이 과정을 쓰지 마라.
- 오직 지정된 JSON 객체 하나만 응답으로 출력해라. 응답의 첫 글자는 반드시 { 여야 한다.

응답은 반드시 아래 JSON 형식 그대로여야 한다 (다른 필드 추가 금지):
{
  "segments": [
    { "index": 0, "note": "완만한 구간, 목표 페이스 유지" }
  ],
  "overall_note": "전체 레이스에 대한 한두 문장 코멘트"
}`;

function buildUserPrompt(payload) {
  const { segments, goal } = payload;
  return JSON.stringify({
    goal,
    segments: segments.map((s) => ({
      index: s.index,
      distance_km: s.distanceKm,
      cumulative_distance_km: s.cumulativeDistanceKm,
      avg_grade_percent: s.avgGradePercent,
      already_computed_target_pace_min_per_km: s.targetPaceMinPerKm,
      already_computed_target_cumulative_seconds: s.targetCumulativeSeconds,
    })),
  });
}

// 구조화된 출력 스키마 — 이걸 강제하면 모델이 코드/설명 등으로 딴 길로 새지 못하고
// 정확히 이 형식의 JSON만 만들어낸다. 숫자는 요구하지 않는다 (전부 서버/클라이언트 계산값 사용).
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          note: { type: "string" },
        },
        required: ["index", "note"],
      },
    },
    overall_note: { type: "string" },
  },
  required: ["segments", "overall_note"],
};

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

    if (!payload || !Array.isArray(payload.segments) || payload.segments.length === 0) {
      return new Response(JSON.stringify({ error: "segments 배열이 필요합니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
    if (payload.segments.length > 60) {
      return new Response(
        JSON.stringify({ error: "구간이 너무 많습니다 (무료 티어 기준 최대 60개 권장). 구간 간격을 더 크게 잡아주세요." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    if (!env.AI) {
      return new Response(
        JSON.stringify({ error: "이 Worker에 AI 바인딩이 설정되어 있지 않습니다. wrangler.toml의 [ai] 설정을 확인하세요." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    let aiResponse;
    try {
      aiResponse = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(payload) },
        ],
        max_tokens: 4096,
        response_format: {
          type: "json_schema",
          json_schema: RESPONSE_JSON_SCHEMA,
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Workers AI 호출 실패", detail: String(err) }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    // response_format을 지원하는 모델은 이미 파싱된 객체를 response 필드로 줄 수도 있고,
    // 문자열로 줄 수도 있어 두 경우 다 처리한다.
    let plan;
    if (aiResponse && typeof aiResponse.response === "object" && aiResponse.response !== null) {
      plan = aiResponse.response;
    } else {
      const rawText = (aiResponse && aiResponse.response) || "";
      try {
        plan = extractJson(rawText);
      } catch {
        return new Response(
          JSON.stringify({ error: "모델 응답을 JSON으로 해석하지 못했습니다.", raw: rawText.slice(0, 1500) }),
          {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          }
        );
      }
    }

    return new Response(JSON.stringify(plan), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  },
};

