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

const SYSTEM_PROMPT = `너는 트레일 러닝 페이스 코치다. 사용자가 업로드한 GPX 코스를 구간으로 나눈 데이터와,
사용자의 목표/컨디션을 받는다. 각 구간마다 목표 페이스(분/km)와 목표 통과 누적시간(초),
그리고 한 줄짜리 코칭 코멘트를 만들어야 한다.

규칙:
- 오르막 구간은 경사도에 비례해 페이스가 느려져야 한다 (Grade-Adjusted Pace 개념 참고).
- 내리막이 너무 가파르면(예: -15% 이상) 부상 위험 때문에 무리하게 빠른 페이스를 주지 않는다.
- 레이스 초반 구간은 사용자가 목표 페이스보다 오버페이스하지 않도록 보수적으로 잡는다.
- 반드시 지정된 JSON 형식으로만 응답한다. 다른 텍스트, 설명, 마크다운을 절대 포함하지 않는다.

응답은 반드시 아래 JSON 형식 그대로여야 한다 (다른 필드 추가 금지):
{
  "segments": [
    {
      "index": 0,
      "target_pace_min_per_km": 6.2,
      "target_cumulative_seconds": 372,
      "note": "완만한 구간, 목표 페이스 유지"
    }
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
      elevation_gain_m: s.elevationGainM,
      elevation_loss_m: s.elevationLossM,
      avg_grade_percent: s.avgGradePercent,
    })),
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

    const rawText = aiResponse.response || "";
    let plan;
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

    return new Response(JSON.stringify(plan), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  },
};

