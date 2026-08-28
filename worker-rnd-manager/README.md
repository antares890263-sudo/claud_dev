# 정부 R&D 사업 AI 매니저 — Cloudflare Worker (완전 무료)

`rnd_manager` 앱의 AI 기능(공고문 분석, 사업계획서 목차 생성)이 사용하는 서버리스 백엔드입니다.
**Cloudflare Workers AI 무료 티어**를 사용해서, 상용 API 키나 결제 등록 없이 동작합니다.

- 하루 10,000 뉴런 무료 (요청 1건당 대략 수백~1천 뉴런 수준)
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

# 3. 이 폴더(worker-rnd-manager/)로 이동해서 배포
cd worker-rnd-manager
wrangler deploy
```

배포가 끝나면 터미널에 이런 주소가 출력됩니다:

```
https://rnd-manager-ai.<당신의-계정>.workers.dev
```

이 주소를 rnd_manager 앱의 **설정 → "Worker 주소"** 칸에 붙여넣으면
"AI로 공고 분석" / "AI로 목차 생성" 기능이 바로 동작합니다.

Worker 주소를 설정하지 않아도 앱 자체는 동작합니다 — 공고 분석/목차 항목을 수동으로 입력하는
기본 모드로 계속 사용할 수 있습니다.

## 요청/응답 형식

### 공고문 분석 (`action: "analyze"`)

**요청**
```json
{
  "action": "analyze",
  "company": { "region": "강원도", "size": "중소기업", "employees": 12, "industry": "AI 개발", "revenue": "8억원", "hasLab": true, "yearsFounded": 5, "techs": ["VLM", "LLM", "제조AI"] },
  "announcementTitle": "2026년 중소기업 기술혁신개발사업",
  "announcementText": "(공고 원문 붙여넣기)"
}
```

**응답**
```json
{
  "fit_level": "높음",
  "fit_reasons": ["보유기술(제조AI)이 공고 지원분야와 일치", "..."],
  "budget_max_text": "최대 5억원",
  "deadline_text": "2026-09-30",
  "consortium_required": "필요",
  "university_allowed": "가능",
  "summary": "...",
  "idea_suggestions": [{ "title": "...", "description": "..." }]
}
```

### 사업계획서 목차 생성 (`action: "outline"`)

**요청**
```json
{
  "action": "outline",
  "company": { "...": "..." },
  "announcementTitle": "...",
  "announcementSummary": "...",
  "idea": { "title": "...", "description": "..." }
}
```

**응답**
```json
{ "outline": [{ "section": "1. 사업 개요", "guide": "..." }] }
```

## 보안 참고
- `index.js` 상단의 `ALLOWED_ORIGINS` 배열에 실제 배포한 사이트 주소(예: `https://your-username.github.io`)를 넣어두면, 그 사이트에서 온 요청만 허용되어 더 안전합니다.
