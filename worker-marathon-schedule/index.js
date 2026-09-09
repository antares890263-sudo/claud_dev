/**
 * 마라톤 일정 실시간 스크래퍼 — Cloudflare Worker
 *
 * 역할:
 *  - marathonmate.store의 전국/지역별 대회 일정 페이지를 서버에서 대신 가져온다
 *    (브라우저에서 직접 fetch하면 CORS에 막혀서 불가능하기 때문에 이 Worker가 중계한다)
 *  - 페이지 안에 심어진 JSON-LD 구조화 데이터(schema.org ItemList/Event)를 우선 파싱해서
 *    대회 목록을 뽑는다. 이 데이터는 원래 검색엔진용 SEO 메타데이터라 대회명/날짜/장소/
 *    상세페이지 링크가 이미 정확한 JSON으로 들어있다 — LLM이 텍스트를 "추측"할 필요가 없다.
 *  - 접수상태·거리처럼 JSON-LD에 없는 정보는, 같은 페이지에서 그 대회 이름 주변 텍스트를
 *    찾아 보조적으로 채운다(표/카드 마크업이 바뀌어도 "이름 주변에서 키워드 찾기"라
 *    비교적 안 깨진다).
 *  - JSON-LD를 전혀 못 찾은 경우에만 예비로 Cloudflare Workers AI(무료 티어)에게
 *    텍스트를 통째로 주고 뽑아달라고 한다.
 *  - 결과를 30분간 캐싱해서 브라우저(마라톤 일정 앱)에 JSON으로 돌려준다.
 *
 * 배포:
 *   cd worker-marathon-schedule
 *   wrangler deploy
 *   (또는 README.md의 브라우저 전용 배포 방법 A/B 참고)
 *
 * 요청 예 (region은 항상 구체적인 지역명이어야 한다 — marathonmate.store엔 "전국 통합"
 * 개념이 없어서 region을 생략하면 업스트림이 서울 지역 기본값만 내려주기 때문):
 *   GET https://<주소>.workers.dev/api/schedule?region=강원     (지역별)
 *   GET https://<주소>.workers.dev/api/schedule?region=강원&force=1   (캐시 무시하고 새로 가져오기)
 *   GET https://<주소>.workers.dev/api/schedule?region=전국     ("전국" 자체도 하나의 지역 카테고리다 —
 *                                                              특정 지역에 안 묶인 전국구 대회들)
 * "전체(모든 지역 합치기)"는 이 Worker가 아니라 호출하는 쪽(앱)이 지역별로 나눠서 호출한 뒤
 * 합치는 방식으로 구현한다 — Cloudflare Workers 무료 플랜의 요청당 subrequest 50개 / CPU 10ms
 * 한도 안에서 19개 지역을 한 번에 서버에서 다 처리하는 건 안전하지 않기 때문이다.
 */

// 실제 배포한 사이트 주소(예: https://your-username.github.io)를 넣어두면
// 그 출처에서 온 요청만 허용되어 더 안전합니다. 비워두면 모든 출처를 허용합니다.
const ALLOWED_ORIGINS = [];

const UPSTREAM = "https://marathonmate.store/domestic";
const CACHE_TTL_SECONDS = 1800; // 30분
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const REGIONS = [
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
  "전국", "기타",
];

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

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

function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|button|a)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{2,}/g, "\n")
  ).trim();
}

/**
 * 문자열 str의 start 위치가 JSON 객체를 여는 '{' 라고 가정하고,
 * 중괄호 깊이를 세어 짝이 맞는 '}' 까지의 부분 문자열을 잘라 반환한다.
 * 문자열(따옴표) 안의 중괄호는 무시한다.
 */
function extractBalancedJson(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 페이지 원문(html) 안에서 "@context":"https://schema.org" 로 시작하는
 * JSON 객체들을 전부 찾아 파싱한다. 표준 <script type="application/ld+json"> 태그
 * 안에 그대로 있든, Next.js 스트리밍 페이로드 조각 안에 원문 그대로 박혀있든
 * (조각은 raw text라 이스케이프 없이 그대로 들어있음) 상관없이 동작하도록
 * "{\"@context\"" 문자열 자체를 앵커로 찾는 방식을 쓴다.
 */
function findJsonLdObjects(html) {
  const results = [];
  const anchor = '{"@context"';
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    const jsonStr = extractBalancedJson(html, idx);
    if (jsonStr) {
      try {
        results.push(JSON.parse(jsonStr));
      } catch (e) {
        // 이 지점에서 시작하는 JSON이 깨졌으면 무시하고 다음 앵커로
      }
      searchFrom = idx + jsonStr.length;
    } else {
      searchFrom = idx + anchor.length;
    }
  }
  return results;
}

/** ItemList(및 그 안의 item이 Event인) 노드들을 재귀적으로 모두 찾는다. */
function collectEventsFromLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectEventsFromLd(n, out);
    return;
  }
  if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
    for (const el of node.itemListElement) {
      const item = el && el.item ? el.item : el;
      if (item && (item["@type"] === "Event" || item.startDate)) {
        out.push(item);
      } else {
        collectEventsFromLd(item, out);
      }
    }
  }
  if (node["@type"] === "Event" && node.startDate) {
    out.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "@type") continue;
    const val = node[key];
    if (val && typeof val === "object") collectEventsFromLd(val, out);
  }
}

function guessRegion(text) {
  if (!text) return null;
  for (const r of REGIONS) {
    if (text.includes(r)) return r;
  }
  return null;
}

function normalizeDate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function dowFor(dateStr) {
  if (!dateStr) return null;
  // "YYYY-MM-DD"를 그 날짜 자체의 UTC 자정으로 해석해서 요일을 구한다. 예전엔
  // "+09:00"(한국시간 자정)을 붙였는데, 그러면 UTC로 변환하면서 하루 전날로
  // 밀려버려서(예: 9/12 00:00 KST = 9/11 15:00 UTC) getUTCDay()가 하루 전 요일을
  // 돌려주는 버그가 있었다(9/12 토요일인데 금요일로 표시됨). 요일은 시간대와 무관한
  // 달력상의 성질이므로 애초에 시간대 변환을 하지 말아야 한다.
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return DOW[d.getUTCDay()];
}

function locationText(loc) {
  if (!loc) return null;
  if (typeof loc === "string") return loc;
  const parts = [];
  if (loc.name) parts.push(loc.name);
  if (loc.address) {
    if (typeof loc.address === "string") parts.push(loc.address);
    else {
      if (loc.address.addressRegion) parts.push(loc.address.addressRegion);
      if (loc.address.addressLocality) parts.push(loc.address.addressLocality);
      if (loc.address.streetAddress) parts.push(loc.address.streetAddress);
    }
  }
  return parts.filter(Boolean).join(" ") || null;
}

/** html 안의 모든 <script>...</script> 구간 [start,end) 목록을 반환한다. */
function computeScriptRanges(html) {
  const ranges = [];
  const re = /<script[\s\S]*?<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideRanges(idx, ranges) {
  for (const [s, e] of ranges) {
    if (idx >= s && idx < e) return true;
  }
  return false;
}

/**
 * idx 이후 가장 가까운 행/카드 닫는 태그(</tr>, </article>, </li>) 위치를 찾아
 * 그 지점 조금 뒤까지를 "이 대회 항목의 끝"으로 본다. 못 찾으면 기본 상한(maxLen)을 쓴다.
 * 이렇게 하면 목록이 촘촘할 때 다음 대회 행의 텍스트까지 같이 읽어버리는 걸 막을 수 있다.
 */
function findRowEnd(html, idx, maxLen) {
  const searchWindow = html.slice(idx, idx + Math.max(maxLen, 2000));
  const re = /<\/(tr|article|li)>/gi;
  const m = re.exec(searchWindow);
  if (!m) return Math.min(html.length, idx + maxLen);
  const earliest = m.index + m[0].length;
  return Math.min(html.length, idx + Math.min(earliest, maxLen));
}

/**
 * idx 이전 가장 가까운 행/카드 닫는 태그(</tr>, </article>, </li>) 위치를 찾아
 * 그 바로 뒤부터를 "이 대회 항목의 시작"으로 본다 — 앞 행의 꼬리 텍스트(이전 대회의
 * 거리/상태 등)가 섞여 들어오는 걸 막기 위함. 못 찾으면 기본 상한(maxBack)을 쓴다.
 */
function findRowStart(html, idx, maxBack) {
  const from = Math.max(0, idx - maxBack);
  const searchWindow = html.slice(from, idx);
  const re = /<\/(tr|article|li)>/gi;
  let last = -1;
  let m;
  while ((m = re.exec(searchWindow))) {
    last = m.index + m[0].length;
  }
  if (last === -1) return from;
  return from + last;
}

/** 마감/접수 키워드 바로 뒤(30자 이내)에 오는 날짜를 찾는다. */
function findDeadlineNear(windowText) {
  const re = /마감|접수/g;
  let m;
  while ((m = re.exec(windowText))) {
    const start = m.index + m[0].length;
    const slice = windowText.slice(start, start + 30);
    const dm = slice.match(/\d{4}[.\-]\d{2}[.\-]\d{2}/);
    if (dm) return normalizeDate(dm[0]);
  }
  return null;
}

/**
 * html 전체에서 name(대회명)이 등장하는 모든 지점 주변 텍스트를 모아,
 * JSON-LD에는 없는 접수상태/거리/마감일 정보를 보조적으로 채운다.
 * 표 마크업이든 카드 마크업이든 상관없이 "이름 주변 텍스트"만 보므로
 * 사이트의 구체적인 class 이름에 의존하지 않는다.
 * JSON-LD <script> 블록 자체 안에서 이름이 매칭되는 경우(그 블록엔 상태/거리
 * 정보가 없어 오탐을 유발함)는 건너뛴다.
 */
function enrichFromNearbyText(html, name, scriptRanges) {
  const result = { status: null, distances: [], deadline: null };
  if (!name) return result;
  const distSet = new Set();
  let searchFrom = 0;
  let windowsChecked = 0;
  while (windowsChecked < 8) {
    const idx = html.indexOf(name, searchFrom);
    if (idx === -1) break;
    searchFrom = idx + name.length;

    if (isInsideRanges(idx, scriptRanges)) continue; // JSON-LD/스크립트 안 매칭은 건너뜀
    windowsChecked++;

    let winStart = findRowStart(html, idx, 300);
    let winEnd = findRowEnd(html, idx + name.length, 900);
    // winStart/winEnd가 (예: 아직 안 닫힌 JSON-LD 스크립트 블록 안쪽처럼) 다른 <script> 구간을
    // 침범하지 않도록 자른다 — 그 구간엔 다른 대회의 이름/텍스트가 섞여 있을 수 있다.
    for (const [s, e] of scriptRanges) {
      if (e > winStart && e <= idx) winStart = Math.max(winStart, e);
      if (s < winEnd && s >= idx + name.length) winEnd = Math.min(winEnd, s);
    }
    const windowText = stripHtml(html.slice(winStart, winEnd));

    if (!result.status) {
      if (/접수중/.test(windowText)) result.status = "open";
      else if (/접수\s*예정|접수전|접수\s*마감\s*임박/.test(windowText)) result.status = "open";
      else if (/접수\s*마감|마감됨/.test(windowText)) result.status = "closed";
    }

    const distMatches = windowText.match(/\d+(?:\.\d+)?\s*(?:km|K)\b/gi) || [];
    for (const d of distMatches) distSet.add(d.replace(/\s+/g, "").replace(/K$/i, "km"));
    if (/하프/.test(windowText)) distSet.add("하프");
    if (/풀\s*코스|풀마라톤/.test(windowText)) distSet.add("풀코스");

    if (!result.deadline) {
      const found = findDeadlineNear(windowText);
      if (found) result.deadline = found;
    }
  }
  result.distances = Array.from(distSet);
  return result;
}

function extractFromJsonLd(html) {
  const ldObjects = findJsonLdObjects(html);
  const rawEvents = [];
  for (const obj of ldObjects) collectEventsFromLd(obj, rawEvents);

  const scriptRanges = computeScriptRanges(html);
  const seen = new Set();
  const events = [];
  for (const raw of rawEvents) {
    const name = raw.name && String(raw.name).trim();
    const date = normalizeDate(raw.startDate);
    if (!name || !date) continue;
    const dedupeKey = `${name}__${date}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const loc = locationText(raw.location);
    const region = guessRegion(loc) || guessRegion(name);
    const enrich = enrichFromNearbyText(html, name, scriptRanges);
    const isTrail = /트레일|trail/i.test(name) || (loc && /트레일|trail/i.test(loc));

    events.push({
      name,
      date,
      day: dowFor(date),
      location: loc,
      distances: enrich.distances,
      status: enrich.status || "unknown",
      deadline: enrich.deadline,
      region: region || null,
      type: isTrail ? "trail" : "road",
      url: raw.url || null,
    });
  }
  return events;
}

/**
 * str[start]가 배열을 여는 '[' 라고 가정하고, 대괄호 깊이를 세어 짝이 맞는 ']' 까지의
 * 부분 문자열을 잘라 반환한다 (extractBalancedJson의 배열 버전).
 */
function extractBalancedArray(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * extractBalancedArray의 "이스케이프된 JSON" 버전. Next.js는 페이지의 리액트 엘리먼트
 * 트리를 self.__next_f.push([1, "23:[...]"]) 형태로 흘려보내는데, 이 두 번째 인자 자체가
 * 하나의 JSON 문자열이라서 그 안의 모든 큰따옴표가 \" 로 이스케이프되어 있다. 그래서
 * "races":[...] 앵커도 실제로는 \"races\":[ 형태로 나타난다. 이 경우 문자열 경계는
 * (일반 큰따옴표가 아니라) \" 토큰으로 판단해야 한다.
 */
function extractBalancedArrayEscaped(str, start) {
  let depth = 0;
  let inStr = false;
  let i = start;
  while (i < str.length) {
    if (inStr) {
      if (str[i] === "\\" && str[i + 1] === "\\") {
        i += 2;
        continue;
      }
      if (str[i] === "\\" && str[i + 1] === '"') {
        inStr = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (str[i] === "\\" && str[i + 1] === '"') {
      inStr = true;
      i += 2;
      continue;
    }
    if (str[i] === "[") {
      depth++;
      i++;
      continue;
    }
    if (str[i] === "]") {
      depth--;
      i++;
      if (depth === 0) return str.slice(start, i);
      continue;
    }
    i++;
  }
  return null;
}

/**
 * marathonmate.store가 서버에서 렌더링한 React 컴포넌트 props 안에는
 * 그 페이지가 실제로 보여주는(=지역·접수상태 필터가 이미 적용된) 대회 목록이
 * "races":[...] 형태의 순수 JSON 배열로 그대로 박혀 있다. JSON-LD보다 훨씬
 * 정확하고 완전한 소스라서 이걸 최우선으로 찾는다.
 *
 * 이 배열은 페이지에 두 가지 형태로 나타날 수 있다:
 *  1) 일반 텍스트 그대로: "races":[{"id":...}]
 *  2) Next.js 스트리밍 페이로드 안에서 JSON 문자열로 한 번 더 감싸져
 *     이스케이프된 형태: \"races\":[{\"id\":...}]
 * 두 형태를 모두 찾아 시도한다.
 */
function extractRacesArray(html) {
  const plainAnchor = '"races":[';
  const plainIdx = html.indexOf(plainAnchor);
  if (plainIdx !== -1) {
    const arrStart = plainIdx + plainAnchor.length - 1;
    const arrStr = extractBalancedArray(html, arrStart);
    if (arrStr) {
      try {
        const parsed = JSON.parse(arrStr);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // 아래 escaped 형태로 계속 시도
      }
    }
  }

  const escapedAnchor = '\\"races\\":[';
  const escapedIdx = html.indexOf(escapedAnchor);
  if (escapedIdx !== -1) {
    const arrStart = escapedIdx + escapedAnchor.length - 1;
    const escapedArrStr = extractBalancedArrayEscaped(html, arrStart);
    if (escapedArrStr) {
      try {
        const unescaped = JSON.parse('"' + escapedArrStr + '"');
        const parsed = JSON.parse(unescaped);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // 파싱 실패 — null 반환
      }
    }
  }

  return null;
}

function normalizeDistanceLabel(d) {
  if (typeof d !== "string") return String(d);
  const m = d.match(/^(\d+(?:\.\d+)?)\s*K$/);
  if (m) return `${m[1]}km`;
  return d;
}

/** races 배열의 한 항목(marathonmate 자체 데이터 모델)을 앱이 쓰는 이벤트 형태로 변환한다. */
function mapRace(r, statusFromQuery) {
  if (!r || !r.id || !r.title || !r.date) return null;
  const date = normalizeDate(r.date);
  if (!date) return null;
  const loc = r.location || null;
  const isTrail = /트레일|trail/i.test(r.title) || (loc && /트레일|trail/i.test(loc));
  return {
    id: r.id,
    name: r.title,
    date,
    day: dowFor(date),
    location: loc,
    distances: Array.isArray(r.distances) ? r.distances.map(normalizeDistanceLabel) : [],
    status: statusFromQuery,
    deadline: normalizeDate(r.registrationEndDate),
    region: r.region || null,
    type: isTrail ? "trail" : "road",
    url: `https://marathonmate.store/race/${r.id}`,
  };
}

/**
 * 요청받은(반드시 실제 지역명이어야 함) region에 대해, marathonmate.store가 실제로 쓰는
 * 3가지 접수상태 필터(접수전/접수중/접수마감)에 해당하는 업스트림 URL 목록을 만든다.
 *
 * 중요: marathonmate.store에는 "전국 통합" 개념이 없다. ?region= 파라미터를 아예 안 넣으면
 * 업스트림은 그냥 서울 지역 기본값을 내려준다(실제 페이지로 확인함) — 그래서 이 함수는
 * region이 항상 구체적인 지역명이라고 가정하고, "all"/빈 값 처리는 fetch 핸들러 쪽에서
 * 미리 걸러낸다(region_required 에러).
 */
// ---------------------------------------------------------------------------
// 실제 접수 사이트 링크 (marathongo.co.kr 교차 매칭)
//
// marathonmate.store 자체에는 접수 링크가 없다("접수 링크 없음 · 주최 공지 확인"). 그래서
// 같은 대회를 다루는 다른 사이트인 marathongo.co.kr(마라톤GO)의 대회 상세페이지에서 실제
// 접수 링크를 찾아 연결한다. marathonmate.store 목록과 이름+날짜로 매칭한다.
//
// 설계(무료 플랜 한도 고려): 이 조회는 앱이 대회 "전체 목록"을 불러올 때가 아니라, 사용자가
// 특정 대회의 상세 모달을 열 때만(그 대회 하나에 대해서만) 호출된다 — /api/schedule처럼 전체
// 지역을 한 번에 처리하지 않으므로 subrequest/CPU 부담이 훨씬 적다. 목록 페이지는 지역/접수
// 상태로 나뉘지 않고 단일 페이지에 전체 대회가 실려 있어(marathonmate.store와 달리 페이지네이션
// 없음) 한 번만 가져오면 되고, 그 결과를 몇 시간 캐시해 재사용한다.
// ---------------------------------------------------------------------------

const MARATHONGO_ORIGIN = "https://marathongo.co.kr";
const MARATHONGO_LIST_URL = `${MARATHONGO_ORIGIN}/raceSchedule/domestic`;
const MARATHONGO_LIST_CACHE_TTL_SECONDS = 14400; // 4시간 — 목록 자체는 자주 안 바뀜
const REGLINK_CACHE_TTL_SECONDS = 43200; // 12시간 — 대회 하나당 결과 캐시

const UPSTREAM_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; MarathonScheduleBot/1.0; personal aggregator)",
  "Accept-Language": "ko-KR,ko;q=0.9",
};

/** 대회명 비교용 정규화: 순번("제12회"), 연도, 공백/구두점을 제거해 표기 차이를 흡수한다. */
function normalizeNameForMatch(name) {
  if (!name) return "";
  return String(name)
    .replace(/제\s*\d+\s*회/g, "")
    .replace(/\d{4}\s*년?/g, "")
    .replace(/[\s\-_.,()·'"~!?/]/g, "")
    .toLowerCase();
}

/** 정규화한 두 이름이 같거나, 한쪽이 다른 쪽에 완전히 포함되면 같은 대회로 본다. */
function namesLikelyMatch(a, b) {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 4 && longer.includes(shorter);
}

/**
 * marathongo.co.kr 목록 페이지(/raceSchedule/domestic) HTML에서 {name, date, slug, region} 목록을
 * 뽑는다. 이 사이트는 마크업 class 이름에 기대지 않고(=바뀌어도 비교적 안 깨지도록) 카드 링크
 * (`/raceDetail/domestic/<slug>`)가 등장하는 지점 주변 텍스트만 본다. 카드 안 텍스트는 항상
 * "날짜 → 거리칩들 → 대회명 → 지역 → 장소 → 집결시간 → 연도 → 접수상태 → ..." 순서로 나타난다
 * (데스크톱/모바일 두 벌의 중복 카드가 있어 slug로 중복 제거한다). 날짜 배지엔 연도가 없고,
 * 연도는 그 뒤 "지역/장소/시간" 블록 끝에 별도로 나온다 — 그래서 월/일 + 그 연도를 합쳐야
 * 완전한 날짜가 나온다.
 */
function extractMarathonGoRaces(html) {
  const results = [];
  const seen = new Set();
  const linkRe = /href="(\/raceDetail\/domestic\/[^"?#]+)"/g;
  let m;
  while ((m = linkRe.exec(html))) {
    const slug = m[1];
    if (seen.has(slug)) continue; // 데스크톱/모바일 중복 카드 스킵
    const idx = m.index;
    const winStart = Math.max(0, idx - 200);
    const winEnd = Math.min(html.length, idx + 2200);
    const windowText = stripHtml(html.slice(winStart, winEnd));

    const dateMatch = windowText.match(/(\d{1,2})월\s*(\d{1,2})일/);
    if (!dateMatch) continue;
    const month = dateMatch[1].padStart(2, "0");
    const day = dateMatch[2].padStart(2, "0");
    const afterDate = dateMatch.index + dateMatch[0].length;

    // 대회명 뒤에 오는 지역명이 처음 등장하는 위치를 찾는다("전국"/"기타"는 흔한 일반 단어라 제외).
    let regionIdx = -1, region = null;
    for (const r of REGIONS) {
      if (r === "전국" || r === "기타") continue;
      const ri = windowText.indexOf(r, afterDate);
      if (ri !== -1 && (regionIdx === -1 || ri < regionIdx)) { region = r; regionIdx = ri; }
    }
    if (regionIdx === -1) continue;

    const name = windowText
      .slice(afterDate, regionIdx)
      .replace(/^[()토일월화수목금\s]+/, "")
      .replace(/\d+(?:\.\d+)?\s*(?:km|k)\b/gi, "")
      .replace(/걷기|하프|풀코스|정원\s*마감/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (name.length < 2) continue; // 대회명 안에 지역명이 섞여 있어 너무 짧게 잘린 경우 등 — 매칭 포기

    const afterRegion = windowText.slice(regionIdx, Math.min(windowText.length, regionIdx + 260));
    const statusIdx = afterRegion.search(/접수중|접수마감|접수전/);
    const yearZone = statusIdx === -1 ? afterRegion : afterRegion.slice(0, statusIdx);
    const yearMatches = yearZone.match(/\b20\d{2}\b/g);
    if (!yearMatches) continue;
    const year = yearMatches[yearMatches.length - 1];

    seen.add(slug);
    results.push({ name, date: `${year}-${month}-${day}`, slug, region });
  }
  return results;
}

/** 목록에서 요청받은 날짜가 정확히 같고 이름이 그럴듯하게 일치하는 첫 항목을 찾는다. */
function findMarathonGoMatch(list, name, date) {
  for (const c of list) {
    if (c.date === date && namesLikelyMatch(c.name, name)) return c;
  }
  return null;
}

/**
 * 대회 상세페이지 HTML에서 실제 접수 링크를 찾는다. marathongo.co.kr은 "신청하기" 버튼의
 * href에만 `utm_source=marathongo` 쿼리를 붙인다(내비게이션/로고 등 다른 링크엔 없음) — 실제
 * 대회 3건을 확인해 검증된 패턴이라 클래스 이름 대신 이 쿼리 문자열을 앵커로 쓴다.
 */
function extractMarathonGoRegLink(html) {
  const m = html.match(/href="([^"]*utm_source=marathongo[^"]*)"/i);
  if (!m) return null;
  const href = decodeEntities(m[1]);
  if (href.startsWith("/") || href.includes("marathongo.co.kr")) return null;
  return href;
}

async function fetchMarathonGoList(ctx) {
  const cacheKey = new Request("https://cache.internal/marathongo-list");
  const cache = caches.default;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  } catch (e) {
    // 캐시 읽기 실패 시 그냥 새로 가져온다
  }

  const res = await fetch(MARATHONGO_LIST_URL, { headers: UPSTREAM_FETCH_HEADERS });
  const html = await res.text();
  const list = extractMarathonGoRaces(html);

  const cacheResponse = new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${MARATHONGO_LIST_CACHE_TTL_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));
  return list;
}

/** name+date로 marathongo.co.kr에서 실제 접수 링크를 찾는다. 결과는 항상 { found, ... } 형태. */
async function lookupRegLink(name, date, ctx) {
  try {
    const list = await fetchMarathonGoList(ctx);
    const match = findMarathonGoMatch(list, name, date);
    if (!match) return { found: false, source: "marathongo" };

    const detailUrl = `${MARATHONGO_ORIGIN}${match.slug}`;
    const detailRes = await fetch(detailUrl, { headers: UPSTREAM_FETCH_HEADERS });
    const detailHtml = await detailRes.text();
    const regUrl = extractMarathonGoRegLink(detailHtml);

    return regUrl
      ? { found: true, url: regUrl, matchedName: match.name, source: "marathongo", detailUrl }
      : { found: false, source: "marathongo", matchedName: match.name, detailUrl };
  } catch (e) {
    return { found: false, error: "lookup_failed" };
  }
}

function buildUpstreamTargets(region) {
  const regionQ = `region=${encodeURIComponent(region)}`;
  return [
    { status: "open", region, url: `${UPSTREAM}?${regionQ}` },
    { status: "pre_open", region, url: `${UPSTREAM}?${regionQ}&status=pre_open` },
    { status: "closed", region, url: `${UPSTREAM}?${regionQ}&status=closed` },
  ];
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

async function extractEventsWithAi(env, html) {
  const text = stripHtml(html);
  const truncated = text.slice(0, 14000);
  const resp = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: truncated },
    ],
    max_tokens: 4000,
  });
  const raw = (resp && resp.response) || "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return { events: [], rawSample: raw.slice(0, 300), textPreview: text.slice(0, 300) };
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? { events: parsed, rawSample: null, textPreview: null }
      : { events: [], rawSample: raw.slice(0, 300), textPreview: text.slice(0, 300) };
  } catch (e) {
    return { events: [], rawSample: raw.slice(0, 300), textPreview: text.slice(0, 300) };
  }
}

// 아래 named export들은 Cloudflare Workers 배포에는 아무 영향이 없고(엔트리포인트는
// default export만 사용됨), 로컬에서 순수 함수 단위로 파싱 로직을 테스트할 때만 쓰인다.
export {
  findJsonLdObjects,
  collectEventsFromLd,
  extractFromJsonLd,
  enrichFromNearbyText,
  guessRegion,
  normalizeDate,
  dowFor,
  findRowStart,
  findRowEnd,
  computeScriptRanges,
  extractBalancedArray,
  extractBalancedArrayEscaped,
  extractRacesArray,
  normalizeDistanceLabel,
  mapRace,
  buildUpstreamTargets,
  normalizeNameForMatch,
  namesLikelyMatch,
  extractMarathonGoRaces,
  findMarathonGoMatch,
  extractMarathonGoRegLink,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (url.pathname === "/api/reglink") {
      const name = (url.searchParams.get("name") || "").trim();
      const date = (url.searchParams.get("date") || "").trim();
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(JSON.stringify({ found: false, error: "invalid_params" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const reglinkCacheUrl = new URL("https://cache.internal/reglink");
      reglinkCacheUrl.searchParams.set("name", name);
      reglinkCacheUrl.searchParams.set("date", date);
      const reglinkCacheKey = new Request(reglinkCacheUrl.toString());
      const cache = caches.default;

      try {
        const cached = await cache.match(reglinkCacheKey);
        if (cached) {
          const bodyObj = await cached.json();
          return new Response(JSON.stringify(bodyObj), {
            headers: { "Content-Type": "application/json", ...corsHeaders(origin), "X-Cache": "HIT" },
          });
        }
      } catch (e) {
        // 캐시 읽기 실패 시 그냥 새로 조회
      }

      const bodyObj = await lookupRegLink(name, date, ctx);

      const cacheResponse = new Response(JSON.stringify(bodyObj), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${REGLINK_CACHE_TTL_SECONDS}` },
      });
      ctx.waitUntil(cache.put(reglinkCacheKey, cacheResponse));

      return new Response(JSON.stringify(bodyObj), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin), "X-Cache": "MISS" },
      });
    }

    if (url.pathname !== "/api/schedule") {
      return new Response(
        JSON.stringify({ error: "not_found", usage: "GET /api/schedule?region=<지역명> (예: 강원, 서울, 전국, 기타) 또는 GET /api/reglink?name=<대회명>&date=<YYYY-MM-DD>" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    const region = (url.searchParams.get("region") || "").trim();
    const forceRefresh = url.searchParams.get("force") === "1";

    // marathonmate.store에는 "전국 통합(all)" 개념이 없다 — region 파라미터를 생략하면
    // 업스트림이 그냥 서울 지역 기본값만 내려준다(실제 페이지로 확인함). 그래서 이 Worker는
    // 반드시 구체적인 지역명을 요구한다. "전체" 보기는 앱이 REGIONS 전체를 지역별로 나눠
    // 각각 이 API를 호출한 뒤 클라이언트에서 합치는 방식으로 구현한다(Cloudflare Workers
    // 무료 플랜의 요청당 subrequest 50개 / CPU 10ms 한도 안에서 안전하게 동작하도록).
    if (!region || region === "all") {
      const body = {
        region: region || "all",
        fetchedAt: new Date().toISOString(),
        events: [],
        error: "region_required",
        detail:
          "marathonmate.store에는 '전국 통합' 개념이 없어서 region 파라미터 없이 요청하면 서울 지역 기본값만 내려옵니다. " +
          "이 API는 반드시 구체적인 지역명(예: 강원, 서울, 전국, 기타)으로 호출해야 합니다. " +
          "여러 지역을 합친 목록이 필요하면 호출하는 쪽에서 지역별로 나눠 호출한 뒤 합쳐주세요.",
      };
      return new Response(JSON.stringify(body), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

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

    // marathonmate.store는 접수전/접수중/접수마감 3개 상태를 별도 쿼리(?status=...)로만
    // 보여준다(기본값은 접수중). 그래서 완전한 목록을 얻으려면 3번 다 가져와야 한다.
    // region을 넣으면 업스트림이 이미 그 지역으로 정확히 필터링해서 내려주므로,
    // 우리가 텍스트로 추측할 필요가 없다. (region은 위에서 이미 실제 지역명임을 확인했다.)
    const targets = buildUpstreamTargets(region);

    let fetchResults;
    try {
      fetchResults = await Promise.all(
        targets.map(async (t) => {
          try {
            const res = await fetch(t.url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; MarathonScheduleBot/1.0; personal aggregator)",
                "Accept-Language": "ko-KR,ko;q=0.9",
              },
            });
            const html = await res.text();
            return { status: t.status, url: t.url, html, ok: true };
          } catch (err) {
            return { status: t.status, url: t.url, html: "", ok: false, error: String(err) };
          }
        })
      );
    } catch (err) {
      const body = {
        region, fetchedAt: new Date().toISOString(), events: [],
        error: "upstream_fetch_failed", detail: String(err),
      };
      return new Response(JSON.stringify(body), {
        status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (fetchResults.every((r) => !r.ok)) {
      const body = {
        region, fetchedAt: new Date().toISOString(), events: [],
        error: "upstream_fetch_failed",
        detail: fetchResults.map((r) => r.error).filter(Boolean).join("; "),
      };
      return new Response(JSON.stringify(body), {
        status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let allEvents = [];
    let source = "races";
    const seen = new Set();
    let totalHtmlLength = 0;
    for (const r of fetchResults) {
      totalHtmlLength += r.html.length;
      let races;
      try {
        races = extractRacesArray(r.html);
      } catch (e) {
        races = null;
      }
      if (!races) continue;
      for (const raw of races) {
        const mapped = mapRace(raw, r.status);
        if (!mapped) continue;
        const key = mapped.id || `${mapped.name}__${mapped.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allEvents.push(mapped);
      }
    }

    let aiDebug = null;
    if (allEvents.length === 0) {
      // races 배열을 하나도 못 찾았을 때만(=사이트 구조가 크게 바뀐 경우) JSON-LD로,
      // 그마저 안 되면 AI로 순서대로 예비 시도한다.
      const primaryHtml = fetchResults.find((r) => r.ok && r.html)?.html || "";
      try {
        allEvents = extractFromJsonLd(primaryHtml);
        if (allEvents.length > 0) source = "jsonld";
      } catch (e) {
        allEvents = [];
      }

      if (allEvents.length === 0) {
        source = "ai";
        if (!env.AI) {
          const body = {
            region, fetchedAt: new Date().toISOString(), events: [],
            error: "no_data_found",
            debug: { htmlLength: totalHtmlLength, source: "none", note: "races 배열과 JSON-LD를 모두 찾지 못했고 AI 바인딩도 없습니다." },
          };
          return new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
        try {
          const extraction = await extractEventsWithAi(env, primaryHtml);
          allEvents = extraction.events;
          aiDebug = { rawSample: extraction.rawSample, textPreview: extraction.textPreview };
        } catch (err) {
          const body = {
            region, fetchedAt: new Date().toISOString(), events: [],
            error: "ai_extract_failed", detail: String(err),
            debug: { htmlLength: totalHtmlLength, source: "none" },
          };
          return new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
      }
    }

    // races/jsonld 소스는 이미 정확히 필터링된 상태로 오지만(특히 races는 업스트림이
    // region으로 걸러줌), 혹시 모를 불일치를 방지하기 위해 한 번 더 확인한다.
    const events = allEvents.filter((e) => !e.region || e.region === region);

    const bodyObj = {
      region,
      fetchedAt: new Date().toISOString(),
      events,
      debug: {
        htmlLength: totalHtmlLength,
        source,
        totalEventsFound: allEvents.length,
        eventCount: events.length,
        fetchedStatuses: fetchResults.map((r) => ({ status: r.status, ok: r.ok })),
        ...(aiDebug || {}),
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
