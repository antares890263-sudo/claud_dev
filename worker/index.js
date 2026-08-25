/**
 * GPX 트레일런 페이스 플래너 — Cloudflare Worker
 *
 * 역할:
 *  - 브라우저에서 온 요청(구간별 거리/경사/고도 + 사용자의 목표/컨디션)을 받아
 *  - Anthropic API를 호출해서 구간별 목표 페이스를 구조화된 JSON으로 받아오고
 *  - 결과를 다시 브라우저로 돌려준다.
 *
 * API 키는 여기(서버)에만 저장되고 브라우저에는 절대 노출되지 않는다.
 *
 * 배포:
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY   ← 여기서 실제 키 입력
 *
 * 배포 후 받는 주소(예: https://gpx-pace-planner.<계정>.workers.dev)를
 * 트래커 앱의 "Worker 주소" 설정란에 붙여넣으면 된다.
 */

// 이 배열에 실제로 앱을 배포한 도메인을 넣어두면 그 출처에서 온 요청만 허용된다.
// 예: ["https://your-username.github.io"]
// 비워두면(빈 배열) 모든 출처를 허용한다 — 개발 중엔 편하지만 운영 시엔 채워 넣는 걸 권장.
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

const SYSTEM_PROMPT = `너는 트레일 러닝 페이스 코치다. 사용자가 업로드한 GPX 코스를 구간으로 나눈 데이터와,
사용자의 목표/컨디션을 받는다. 각 구간마다 목표 페이스(분/km)와 목표 통과 누적시간(초),
그리고 한 줄짜리 코칭 코멘트를 만들어야 한다.

규칙:
- 오르막 구간은 경사도에 비례해 페이스가 느려져야 한다 (Grade-Adjusted Pace 개념 참고).
- 내리막이 너무 가파르면(예: -15% 이상) 부상 위험 때문에 무리하게 빠른 페이스를 주지 않는다.
- 레이스 초반 구간은 사용자가 목표 페이스보다 오버페이스하지 않도록 보수적으로 잡는다.
- 반드시 지정된 JSON 스키마로만 응답한다. 다른 텍스트, 설명, 마크다운을 절대 포함하지 않는다.`;

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

const RESPONSE_SCHEMA_HINT = `응답은 반드시 아래 JSON 형식 그대로여야 한다 (다른 필드 추가 금지):
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
    if (payload.segments.length > 200) {
      return new Response(JSON.stringify({ error: "구간이 너무 많습니다 (최대 200개)." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: SYSTEM_PROMPT + "\n\n" + RESPONSE_SCHEMA_HINT,
        messages: [{ role: "user", content: buildUserPrompt(payload) }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return new Response(
        JSON.stringify({ error: "Claude API 호출 실패", detail: errText }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    const data = await anthropicRes.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let plan;
    try {
      plan = JSON.parse(textBlock ? textBlock.text : "{}");
    } catch {
      return new Response(
        JSON.stringify({ error: "Claude 응답을 JSON으로 해석하지 못했습니다.", raw: textBlock?.text }),
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
