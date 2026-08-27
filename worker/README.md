# GPX 페이스 플래너 — Cloudflare Worker (완전 무료)

GPX 트래커 앱의 "레이스 페이스 계획" 기능이 사용하는 서버리스 백엔드입니다.
**Cloudflare Workers AI 무료 티어**를 사용해서, 상용 API 키나 결제 등록 없이 동작합니다.

- 하루 10,000 뉴런 무료 (LLM 응답 기준 대략 15~25회 정도, 페이스 계획 용도로는 충분)
- 신용카드 등록 불필요
- 별도 API 키 관리 불필요 — Cloudflare 계정에 붙이는 것만으로 끝

## 사전 준비
- Node.js 설치되어 있어야 함
- Cloudflare 계정 (무료 가입: https://dash.cloudflare.com, 카드 필요 없음)

## 배포 방법

```bash
# 1. wrangler(Cloudflare CLI) 설치
npm install -g wrangler

# 2. Cloudflare 로그인 (브라우저 창이 열립니다)
wrangler login

# 3. 이 폴더(worker/)로 이동해서 배포
cd worker
wrangler deploy
```

**끝입니다.** API 키를 따로 등록하는 단계가 없습니다 — `wrangler.toml`에 있는 `[ai]` 바인딩이
자동으로 여러분의 Cloudflare 계정에 연결되어, 무료 티어 안에서 바로 동작합니다.

배포가 끝나면 터미널에 이런 주소가 출력됩니다:

```
https://gpx-pace-planner.<당신의-계정>.workers.dev
```

이 주소를 GPX 트래커 앱의 **"레이스 페이스 계획" → "실시간 API" 탭 → "Worker 주소"** 칸에
붙여넣으면 "페이스 계획 받기" 기능이 바로 동작합니다.

## 무료 한도 관련 참고사항

- 하루 10,000 뉴런이 초기화되는 시각은 UTC 00:00 (한국시간 오전 9시)입니다.
- 구간이 너무 많으면(60개 초과) 한 번에 처리하기 무거워질 수 있어 Worker가 요청을 거절하도록 해뒀습니다 — 구간 간격을 2~5km 정도로 넉넉하게 잡으면 충분합니다.
- 한도를 넘으면 유료 전환($0.011 / 1,000 뉴런)되는데, 카드를 등록하지 않으면 애초에 한도를 넘는 순간 요청이 실패할 뿐이라 의도치 않게 돈이 나갈 일은 없습니다.
- 더 똑똑한 모델이 필요하면 `index.js` 상단의 `MODEL` 값을 다른 Workers AI 모델로 바꿀 수 있습니다 (단, 큰 모델일수록 뉴런을 더 빨리 소모합니다).

## 보안 참고
- `index.js` 상단의 `ALLOWED_ORIGINS` 배열에 실제 배포한 사이트 주소(예: `https://your-username.github.io`)를 넣어두면, 그 사이트에서 온 요청만 허용되어 더 안전합니다. 비워두면 모든 출처를 허용합니다 (개발 중엔 편하지만 운영 시엔 채워 넣는 걸 권장).

## 요청/응답 형식

**요청 (POST, Content-Type: application/json)**
```json
{
  "goal": { "type": "target_time", "target_time_minutes": 360, "notes": "무릎이 약함, 내리막 조심" },
  "segments": [
    { "index": 0, "distanceKm": 2.0, "cumulativeDistanceKm": 2.0, "elevationGainM": 40, "elevationLossM": 5, "avgGradePercent": 1.8 }
  ]
}
```

**응답**
```json
{
  "segments": [
    { "index": 0, "target_pace_min_per_km": 6.2, "target_cumulative_seconds": 744, "note": "완만한 구간, 목표 페이스 유지" }
  ],
  "overall_note": "초반은 보수적으로, 후반 오르막을 대비해 힘을 아끼세요."
}
```
