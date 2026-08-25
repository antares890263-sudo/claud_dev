# GPX 페이스 플래너 — Cloudflare Worker

GPX 트래커 앱의 "레이스 페이스 계획" 기능이 사용하는 서버리스 백엔드입니다.
Anthropic API 키를 브라우저에 노출하지 않고 안전하게 보관하면서 Claude를 호출합니다.

## 사전 준비
- Node.js 설치되어 있어야 함
- Cloudflare 계정 (무료 가입: https://dash.cloudflare.com)
- Anthropic API 키 (https://console.anthropic.com)

## 배포 방법

```bash
# 1. wrangler(Cloudflare CLI) 설치
npm install -g wrangler

# 2. Cloudflare 로그인 (브라우저 창이 열립니다)
wrangler login

# 3. 이 폴더(worker/)로 이동해서 배포
cd worker
wrangler deploy

# 4. API 키를 서버 쪽에만 안전하게 저장 (배포와 별개로 한 번만)
wrangler secret put ANTHROPIC_API_KEY
# → 프롬프트가 뜨면 Anthropic API 키를 붙여넣고 Enter
```

배포가 끝나면 터미널에 이런 주소가 출력됩니다:

```
https://gpx-pace-planner.<당신의-계정>.workers.dev
```

이 주소를 GPX 트래커 앱의 "Worker 주소" 설정칸에 붙여넣으면 "페이스 계획 받기" 기능이 동작합니다.

## 보안 참고
- `index.js` 상단의 `ALLOWED_ORIGINS` 배열에 실제 배포한 사이트 주소(예: `https://your-username.github.io`)를 넣어두면, 그 사이트에서 온 요청만 허용되어 더 안전합니다. 비워두면 모든 출처를 허용합니다 (개발 중엔 편하지만 운영 시엔 채워 넣는 걸 권장).
- API 키는 `wrangler secret put` 으로만 등록하세요. 코드에 직접 적으면 GitHub에 올라갈 때 유출됩니다.

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
