/**
 * 마라톤 일정 실시간 스크래퍼 — Cloudflare Worker (Workers AI 무료 티어 사용)
 *
 * 역할:
 *  - marathonmate.store의 전국/지역별 대회 일정 페이지를 서버에서 대신 가져온다
 *    (브라우저에서 직접 fetch하면 CORS에 막혀서 불가능하기 때문에 이 Worker가 중계한다)
 *  - Cloudflare Workers AI 무료 티어 LLM으로 페이지 텍스트에서 대회 목록을
 *    구조화된 JSON으로 추출한다 (CSS 선택자 대신 의미 기반으로 뽑기 때문에,
 *    사이트의 HTML 구조가 바뀌어도 CSS 셀렉터 스크래퍼보다는 덜 쉽게 깨진다)
 *  - 결과를 30분간 캐싱해서 브라우저(마라톤 일정 앱)에 JSON으로 돌려준다
 *
 * 상용 API 키가 전혀 필요 없다 — Cloudflare 계정에 AI 바인딩만 걸어두면 끝.
 *
 * 배포:
 *   cd worker-marathon-schedule
 *   wrangler deploy
 *
 * 요청 예:
 *   GET https://<주소>.workers.dev/api/schedule?region=all     (전국 통합)
 *   GET https://<주소>.workers.dev/api/schedule?region=강원     (지역별)
 *   GET https://<주소>.workers.dev/api/schedule?region=강원&force=1   (캐시 무시하고 새로 가져오기)
 *
 * ⚠️ 중요한 주의사항 (README.md에도 자세히 적어뒀습니다):
 *  1) marathonmate.store가 목록을 자바스크립트로 나중에 채워 넣는 방식(클라이언트 렌더링)이면,
 *     이 Worker는 빈 뼈대 HTML만 받아오게 되어 events가 계속 빈 배열로 나올 수 있습니다.
 *     그런 경우 응답의 debug 필드(htmlLength, textPreview)를 보고 원인을 확인하세요.
 *  2) 사이트 구조가 바뀌면 추출 품질이 떨어질 수 있습니다 — 주기적으로 결과를 확인해주세요.
 *  3) 다른 사이트를 자동으로 긁어와 재표시하는 것이 그 사이트 이용약관에 맞는지는
 *     별도로 꼭 확인하세요. 이 코드는 개인용 조회 목적의 예시로 제공됩니다.
 */

// 실제 배포한 사이트 주소(예: https://your-username.github.io)를 넣어두면
// 그 출처에서 온 요청만 허용되어 더 안전합니다. 비워두면 모든 출처를 허용합니다.
const ALLOWED_ORIGINS = [];

const UPSTREAM = "https://marathonmate.store/domestic";
const CACHE_TTL_SECONDS = 1800; // 30분 — 값을 늘리면 Workers AI 호출 횟수(무료 한도)를 아낄 수 있습니다.
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function corsHeaders(origin) {
  const allowOrigin =
    ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)
      ? (origin || "*")
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|button|a)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const EXTRACT_SYSTEM_PROMPT = `너는 한국 마라톤/러닝 대회 일정 페이지의 텍스트를 구조화된 JSON으로 변환하는 파서다.
아래에 웹페이지에서 태그를 제거한 본문 텍스트가 주어진다. 이 텍스트에서 "대회 목록" 항목들을 찾아
각 대회마다 다음 필드를 가진 객체로 만들어라:

- name: 대회명 (문자열)
- date: 대회 날짜, 반드시 "YYYY-MM-DD" 형식으로 변환
- day: 요일 한 글자 (예: "토","일","금"). 텍스트에 없으면 날짜로부터 계산해라.
- location: 대회 장소 (문자열, 시/군/구 + 구체적 장소)
- distances: 종목/거리 배열 (예: ["10km","5km"] 또는 ["하프","10km"] 등 텍스트 표기 그대로)
- status: "open"(접수중) 또는 "closed"(접수마감/접수전/마감) 중 하나
- deadline: 접수마감일이 명시되어 있으면 "YYYY-MM-DD", 없으면 null
- region: 대회가 속한 광역 시/도 (예: "서울","강원","경기","부산" 등)
- type: 이름이나 종목에 "트레일"이 포함되거나 산길 코스로 보이면 "trail", 일반 도로 마라톤이면 "road"

규칙:
- 반드시 유효한 JSON 배열만 출력해라. 설명 문장, 마크다운, 코드블록 표시(\`\`\`)를 절대 붙이지 마라.
- 대회 항목을 찾을 수 없으면 빈 배열 []을 출력해라.
- 메뉴, 광고, 푸터, 대회와 무관한 텍스트는 무시해라.
- 최대 60개까지만 추출해라.`;

async function extractEvents(env, pageText) {
  const truncated = pageText.slice(0, 14000);
  const resp = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: truncated },
    ],
    max_tokens: 4000,
  });
  const raw = (resp && resp.response) || "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return { events: [], rawSample: raw.slice(0, 300) };
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? { events: parsed, rawSample: null }
      : { events: [], rawSample: raw.slice(0, 300) };
  } catch (e) {
    return { events: [], rawSample: raw.slice(0, 300) };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (url.pathname !== "/api/schedule") {
      return new Response(
        JSON.stringify({ error: "not_found", usage: "GET /api/schedule?region=all|<지역명>" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    const region = (url.searchParams.get("region") || "all").trim();
    const forceRefresh = url.searchParams.get("force") === "1";

    const cacheKeyUrl = new URL(request.url);
    cacheKeyUrl.searchParams.delete("force");
    const cacheKey = new Request(cacheKeyUrl.toString());
    const cache = caches.default;

    if (!forceRefresh) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const bodyObj = await cached.json();
          return new Response(JSON.stringify(bodyObj), {
            headers: { "Content-Type": "application/json", ...corsHeaders(origin), "X-Cache": "HIT" },
          });
        }
      } catch (e) {
        // 캐시를 못 읽어도 그냥 새로 가져오면 되니 무시
      }
    }

    const target = region === "all" ? UPSTREAM : `${UPSTREAM}?region=${encodeURIComponent(region)}`;

    let html;
    try {
      const upstreamRes = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MarathonScheduleBot/1.0; personal aggregator)",
          "Accept-Language": "ko-KR,ko;q=0.9",
        },
      });
      html = await upstreamRes.text();
    } catch (err) {
      const body = {
        region, fetchedAt: new Date().toISOString(), events: [],
        error: "upstream_fetch_failed", detail: String(err),
      };
      return new Response(JSON.stringify(body), {
        status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const text = stripHtml(html);

    if (!env.AI) {
      const body = {
        region, fetchedAt: new Date().toISOString(), events: [],
        error: "ai_binding_missing",
        debug: { htmlLength: html.length, textPreview: text.slice(0, 300) },
      };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let extraction;
    try {
      extraction = await extractEvents(env, text);
    } catch (err) {
      const body = {
        region, fetchedAt: new Date().toISOString(), events: [],
        error: "ai_extract_failed", detail: String(err),
        debug: { htmlLength: html.length, textPreview: text.slice(0, 300) },
      };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const bodyObj = {
      region,
      fetchedAt: new Date().toISOString(),
      events: extraction.events,
      debug: {
        htmlLength: html.length,
        textLength: text.length,
        eventCount: extraction.events.length,
        rawSample: extraction.rawSample,
        textPreview: extraction.events.length === 0 ? text.slice(0, 300) : undefined,
      },
    };

    const cacheResponse = new Response(JSON.stringify(bodyObj), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` },
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));

    return new Response(JSON.stringify(bodyObj), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin), "X-Cache": "MISS" },
    });
  },
};
