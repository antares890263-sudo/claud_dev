# 마라톤 일정 실시간 스크래퍼 — Cloudflare Worker (완전 무료)

`marathon-schedule` 앱의 "실시간 대회 정보" 기능이 사용하는 서버리스 백엔드입니다.
브라우저는 marathonmate.store를 직접 fetch할 수 없어서(CORS 정책) 이 Worker가 대신 그 페이지를
가져온 뒤, **Cloudflare Workers AI 무료 티어**로 대회 목록을 구조화된 JSON으로 뽑아 앱에 돌려줍니다.

- 하루 10,000 뉴런 무료 (지역/전체 조회 1건당 수백~1천 뉴런 수준, 30분 캐시가 있어 실제 호출은 훨씬 적음)
- 신용카드 등록 불필요
- 별도 API 키 관리 불필요 — Cloudflare 계정에 AI 바인딩만 걸어두면 끝

## 왜 CSS 셀렉터로 긁지 않고 AI로 뽑나요?

marathonmate.store의 실제 HTML 구조(클래스명 등)를 미리 확인할 수 없는 상태로 이 Worker를 작성했습니다.
그래서 "특정 class 이름"에 의존하는 스크래퍼 대신, 페이지의 텍스트를 통째로 LLM에게 주고
"대회명·날짜·장소·거리·접수상태"를 의미 기반으로 뽑아내게 만들었습니다. 사이트의 디자인/마크업이
바뀌어도 텍스트 내용 자체만 남아있다면 계속 동작할 가능성이 더 높습니다.

## 배포 전에 꼭 확인해주세요 (중요)

1. **클라이언트 렌더링 위험**: marathonmate.store가 대회 목록을 자바스크립트로 나중에 채워 넣는
   방식(예: React/Next.js의 클라이언트 사이드 렌더링)이라면, 이 Worker의 `fetch()`는 자바스크립트를
   실행하지 않기 때문에 빈 뼈대 HTML만 받아오게 되어 `events`가 계속 빈 배열로 나올 수 있습니다.
   배포 후 응답에 `events: []`만 계속 나온다면, 응답의 `debug.textPreview` 값을 확인해서
   실제로 대회 정보 텍스트가 담겨왔는지 먼저 확인해보세요. 만약 비어있다면 이 방식(서버에서 raw HTML만
   가져오는 방식) 대신 헤드리스 브라우저(Playwright 등)로 렌더링까지 하는 방식이 필요합니다 —
   이 경우 Cloudflare Workers 대신 별도 서버가 필요할 수 있으니 알려주시면 다른 방식으로 다시
   만들어 드릴 수 있습니다.
2. **이용약관/저작권**: 다른 사이트의 콘텐츠를 자동으로 가져와 재표시하는 것이 marathonmate.store의
   이용약관에 맞는지 별도로 확인해주세요. 이 Worker는 개인용 조회 목적의 예시로 제공됩니다. 상업적 배포나
   공개 서비스로 확장할 계획이 있다면 원 사이트에 문의하거나 공식 데이터 제공(API/제휴)을 요청하는 것을
   권장합니다.
3. **정확도**: LLM 추출이라 100% 정확하다는 보장은 없습니다. 접수 마감일이나 상태가 실제와 다를 수 있으니,
   앱 화면에도 "참고용" 문구와 원문 확인 링크가 함께 표시됩니다.

## 사전 준비
- Cloudflare 계정 (무료 가입: https://dash.cloudflare.com, 카드 필요 없음)
- **터미널/wrangler CLI는 필요 없습니다.** 아래 두 방법 모두 브라우저만으로 끝납니다.

## 배포 방법 (터미널 없이, 브라우저만으로)

### 방법 A — Cloudflare가 GitHub 레포를 직접 연결해서 자동 배포 (추천)

이 폴더를 GitHub에 push해두기만 하면, 이후로는 이 폴더에 변경사항을 push할 때마다 Cloudflare가
알아서 다시 배포해줍니다. `site/`가 GitHub Actions로 자동 배포되는 것과 같은 감각으로 쓸 수 있어요.

1. https://dash.cloudflare.com 접속 → 로그인 (없으면 무료 가입, 카드 불필요)
2. 왼쪽 메뉴에서 **Workers & Pages** 클릭 → **Create** → **Workers** 탭에서 **Import a repository**
   (또는 "Connect to Git")를 선택
3. GitHub 계정 연결 — 처음 한 번만 브라우저에서 권한 승인을 요청합니다
4. 대상 저장소(`claud_dev`) 선택
5. **Root directory(루트 디렉터리)**를 저장소 최상위가 아니라 `worker-marathon-schedule` 로 지정
   (이 폴더 안의 `wrangler.toml`을 기준으로 배포되도록 하는 설정입니다)
6. 빌드 설정은 기본값 그대로 두고 **Save and Deploy** 클릭 — `wrangler.toml`에 이미 적어둔
   `[ai] binding = "AI"` 설정도 자동으로 함께 적용됩니다
7. 배포가 끝나면 주소가 표시됩니다: `https://marathon-schedule-live.<당신의-계정>.workers.dev`

### 방법 B — Cloudflare 대시보드에서 코드를 바로 붙여넣기 (지금 바로 테스트하고 싶을 때)

GitHub 연결 없이 가장 빨리 테스트해보는 방법입니다. 다만 나중에 코드를 고치면 자동으로 반영되지
않고, 이 에디터에 다시 붙여넣어야 합니다.

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Workers** →
   **Create Worker** (또는 "Start with Hello World!") 선택
2. 이름을 정하고(예: `marathon-schedule-live`) 일단 기본 코드 그대로 **Deploy** 클릭
3. 배포된 화면에서 **Edit code** 클릭 — 브라우저 안에서 코드를 수정할 수 있는 에디터가 열립니다
4. 에디터의 기존 코드를 전부 지우고, 이 폴더의 `index.js` 내용 전체를 그대로 붙여넣기
5. 우측 상단 **Deploy** 클릭
6. **Workers AI 바인딩 추가** (이 단계를 빠뜨리면 대회 목록 추출이 안 됩니다):
   해당 Worker 화면 → **Settings** 탭 → **Variables and Bindings**(또는 **Bindings**) →
   **Add binding** → 타입에서 **Workers AI** 선택 → 이름(Variable name)에 정확히 `AI` 입력 → 저장
   (저장하면 자동으로 다시 배포됩니다)
7. 상단에 표시되는 주소를 그대로 사용하면 됩니다

### 배포 후 공통 — 앱에 연결하기

배포된 주소(`https://marathon-schedule-live.<계정>.workers.dev`)를
`marathon-schedule` 앱의 **"실시간 연동 설정" → Worker 주소** 칸에 그대로 붙여넣으면 실시간 조회가
바로 동작합니다. Worker 주소를 설정하지 않아도 앱 자체는 동작합니다 — 미리 담아둔 예시 일정
(강원 2026)을 보여주는 기본 모드로 계속 사용할 수 있습니다.

### 참고 — 터미널을 쓸 수 있는 경우 (wrangler CLI)

로컬에 Node.js와 터미널이 있다면 기존 `worker/`, `worker-rnd-manager/`와 동일하게
`npm install -g wrangler` → `wrangler login` → 이 폴더에서 `wrangler deploy` 로도 배포할 수 있습니다.
방법 A/B와 결과는 동일합니다.

## 요청/응답 형식

**요청**
```
GET /api/schedule?region=all        전국 통합 일정
GET /api/schedule?region=강원        지역별 일정 (강원/서울/부산/경기 등 광역 시·도 이름)
GET /api/schedule?region=강원&force=1   캐시를 무시하고 강제로 새로 가져오기
```

**응답**
```json
{
  "region": "강원",
  "fetchedAt": "2026-09-08T05:00:00.000Z",
  "events": [
    {
      "name": "커피 빵빵런2026",
      "date": "2026-05-09",
      "day": "토",
      "location": "강릉 경포호수광장",
      "distances": ["10km", "5km"],
      "status": "open",
      "deadline": null,
      "region": "강원",
      "type": "road"
    }
  ],
  "debug": { "htmlLength": 12345, "textLength": 3456, "eventCount": 1 }
}
```

## 캐시 / 무료 한도 관련 참고사항

- 같은 `region` 조회는 30분간 캐시됩니다 (`index.js` 상단 `CACHE_TTL_SECONDS`로 조정 가능). 캐시 덕분에
  방문자가 몰려도 Workers AI 호출과 marathonmate.store에 대한 요청 횟수가 크게 늘어나지 않습니다.
- 하루 10,000 뉴런이 초기화되는 시각은 UTC 00:00(한국시간 오전 9시)입니다.
- 한도를 넘으면 유료 전환($0.011 / 1,000 뉴런)되는데, 카드를 등록하지 않으면 애초에 한도를 넘는 순간
  요청이 실패할 뿐이라 의도치 않게 돈이 나갈 일은 없습니다.

## 보안 참고
- `index.js` 상단의 `ALLOWED_ORIGINS` 배열에 실제 배포한 사이트 주소(예: `https://your-username.github.io`)를
  넣어두면, 그 사이트에서 온 요청만 허용되어 더 안전합니다. 비워두면 모든 출처를 허용합니다(개발 중엔 편하지만
  운영 시엔 채워 넣는 걸 권장합니다).
