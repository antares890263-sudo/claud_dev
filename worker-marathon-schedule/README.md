# 마라톤 일정 실시간 스크래퍼 — Cloudflare Worker (완전 무료)

`marathon-schedule` 앱의 "실시간 대회 정보" 기능이 사용하는 서버리스 백엔드입니다.
브라우저는 marathonmate.store를 직접 fetch할 수 없어서(CORS 정책) 이 Worker가 대신 그 페이지를
가져온 뒤, 대회 목록을 구조화된 JSON으로 뽑아 앱에 돌려줍니다.

- 신용카드 등록 불필요
- 별도 API 키 관리 불필요

## 어떻게 대회 목록을 뽑나요? (races 데이터 우선, JSON-LD와 AI는 예비용) 

처음 버전은 페이지 텍스트를 통째로 Workers AI에게 주고 뽑게 했었는데, 실제로 배포해서 확인해보니
그보다 훨씬 좋은 소스가 페이지 안에 이미 있었습니다. `marathonmate.store`는 Next.js 서버 컴포넌트라서,
`?region=강원`처럼 지역·접수상태를 쿼리로 넘기면 **그 조건에 딱 맞게 필터링된 대회 목록을 `"races":[...]`
형태의 순수 JSON 배열로 페이지 안에 그대로 심어서 내려줍니다** — 대회명·날짜·장소·지역·거리·정확한
접수상태(`open`/`pre_open`/`closed`)·접수 시작일·마감일까지 전부 포함된, 사이트 자체 데이터베이스
값 그대로입니다. 이게 JSON-LD(검색엔진용, 지역과 무관하게 항상 12개만 나오는 "인기 대회" 스니펫)보다
훨씬 정확하고 완전합니다. 그래서 지금은:

1. **1순위 — `races` 배열 파싱**: marathonmate.store는 접수전/접수중/접수마감을 별도 쿼리
   (`?status=pre_open`, 기본값, `?status=closed`)로만 보여주기 때문에, Worker가 region당 이 3가지를
   전부 요청해서 합칩니다. 각 응답 안의 `"races":[...]` JSON을 찾아 파싱합니다 — 페이지에 평문으로
   있든, Next.js 스트리밍 페이로드 안에서 한 번 이스케이프된 채로 있든(`\"races\":[...]`) 둘 다
   찾아냅니다. (참고: marathonmate.store에는 "전국 통합" 개념이 없어서 `region` 파라미터를 생략하면
   그냥 서울 지역 기본값만 내려줍니다 — 그래서 이 Worker는 반드시 구체적인 지역명을 요구하고, "전체"
   보기는 앱이 지역별로 나눠 호출한 뒤 합치는 방식으로 처리합니다. 아래 "전체 지역 합치기" 항목 참고.)
2. **2순위 — JSON-LD 파싱 (예비)**: `races` 배열을 전혀 못 찾았을 때(사이트 구조가 크게 바뀐 경우
   등)만, 페이지의 검색엔진용 구조화 데이터(`<script type="application/ld+json">` 안의 schema.org
   `ItemList`/`Event`)를 대신 찾아 씁니다. 이 경로는 지역별로 정확히 필터링되지 않고 개수도 제한적일
   수 있어 정확도가 1순위보다 떨어집니다.
3. **3순위 — Workers AI (최후 예비)**: 위 두 방법 다 실패했을 때만 페이지 텍스트를 통째로
   **Cloudflare Workers AI 무료 티어**(하루 10,000 뉴런, 카드 불필요)에게 주고 의미 기반으로 뽑아달라고
   합니다. 평소엔 이 경로를 거의 안 타므로 무료 한도를 걱정할 일이 거의 없습니다.

응답의 `debug.source` 값으로 이번 조회가 `"races"`(가장 정확), `"jsonld"`(예비), `"ai"`(최후 예비) 중
어느 경로를 탔는지 확인할 수 있고, `debug.fetchedStatuses`로 접수전/접수중/접수마감 3개 요청이 각각
성공했는지도 볼 수 있습니다.

### "전체" 지역 합치기는 왜 Worker가 아니라 앱이 하나요?

처음엔 `region=all`이면 Worker가 알아서 전국 대회를 다 합쳐서 주면 되겠다고 생각했는데, 실제로 확인해보니
두 가지 문제가 있었습니다.

1. **애초에 marathonmate.store엔 "전국 통합" 조회가 없습니다.** `region` 파라미터를 생략하고 요청하면
   업스트림은 그냥 **서울** 지역 기본값만 내려줍니다(실제 사이트로 직접 확인함). 그래서 예전 버전의
   `region=all`은 사실 "서울 지역만 보여주면서 전체인 척"하고 있었던 것이었고, 이게 "대회가 너무 적다"는
   문제의 진짜 원인이었습니다.
2. **그래서 지역별로 하나씩 다 물어봐야 하는데, 이걸 Worker 하나가 한 번에 하기엔 무료 플랜 한도가 너무
   빠듯합니다.** 지역이 19개(서울/부산/···/전국/기타)이고 지역당 3개 상태(접수전/접수중/접수마감)를
   물어봐야 하니 57번의 외부 요청이 필요한데, Cloudflare Workers **무료 플랜은 요청 하나당 외부
   fetch가 최대 50개**로 제한되어 있고, **CPU 시간도 요청당 10ms**로 빠듯합니다. 이 안에서 안전하게
   끝낸다는 보장이 없습니다.

그래서 이 Worker는 **항상 구체적인 지역명 하나만** 받도록 하고(`region=all`이나 빈 값으로 요청하면
`region_required` 에러를 돌려줍니다), "전체" 보기는 **`marathon-schedule` 앱이 지역 19개를 병렬로
각각 이 API에 요청한 뒤 브라우저에서 합치는 방식**으로 구현했습니다. 지역 하나당 요청은 원래
검증된 3-상태 fetch 그대로라 한도 걱정이 없고, 지역 하나가 실패해도 나머지 지역은 정상 표시되며,
한번 조회된 지역은 30분 캐시가 있어서 다음 "전체" 조회부터는 대부분 캐시로 빠르게 응답합니다.

## 배포 전에 꼭 확인해주세요 (중요)

1. **사이트 구조가 바뀌면 깨질 수 있음**: `races` 배열은 marathonmate.store가 자기 화면을 그리기 위해
   페이지 안에 직접 심어두는 데이터라 갑자기 없어지진 않겠지만, 혹시 사이트가 개편되어 이 데이터 형태
   자체가 바뀌거나(필드명 변경 등) 완전히 다른 방식(예: 데이터를 나중에 별도 API로만 불러오는 방식)으로
   바뀌면 `races` 추출이 실패할 수 있습니다. 이때는 자동으로 JSON-LD → AI 순서로 예비 경로를 타므로
   완전히 빈 목록이 나오는 일은 드물지만, 정확도는 떨어질 수 있습니다. 응답에 `events: []`만 계속
   나온다면 `debug.source`(`"races"`/`"jsonld"`/`"ai"`/`"none"`)와 `debug.totalEventsFound`,
   `debug.fetchedStatuses` 값을 먼저 확인해보세요. `"none"`이면 알려주세요 — 다른 방식(예: 헤드리스
   브라우저)으로 다시 만들어 드릴 수 있습니다.
2. **이용약관/저작권**: 다른 사이트의 콘텐츠를 자동으로 가져와 재표시하는 것이 marathonmate.store의
   이용약관에 맞는지 별도로 확인해주세요. 이 Worker는 개인용 조회 목적의 예시로 제공됩니다. 상업적 배포나
   공개 서비스로 확장할 계획이 있다면 원 사이트에 문의하거나 공식 데이터 제공(API/제휴)을 요청하는 것을
   권장합니다.
3. **정확도**: `debug.source`가 `"races"`일 때는 대회명·날짜·장소·거리·접수상태·마감일·상세링크
   전부 marathonmate.store 자체 데이터베이스 값을 그대로 옮긴 것이라 정확도가 가장 높습니다. 다만
   예비 경로(`"jsonld"`/`"ai"`)로 넘어간 경우엔 접수상태·거리·마감일이 페이지 텍스트에서 보조적으로
   추출되거나 LLM이 추측한 값이라 실제와 다를 수 있습니다. 앱 화면에도 "참고용" 문구와 원문 확인 링크가
   함께 표시됩니다.

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

**요청** (`region`은 항상 구체적인 지역명이어야 합니다 — 위 "전체 지역 합치기" 설명 참고)
```
GET /api/schedule?region=강원        지역별 일정 (강원/서울/부산/경기 등 광역 시·도 이름, "전국"/"기타" 포함)
GET /api/schedule?region=강원&force=1   캐시를 무시하고 강제로 새로 가져오기
GET /api/schedule?region=all         → 400 에러 (region_required) — 지역을 생략하면 항상 이렇게 됩니다
```

내부적으로는 region당 접수전(`pre_open`)/접수중(`open`)/접수마감(`closed`) 3개 요청을 marathonmate.store에
보내서 합칩니다. `force=1`을 주면 이 3개 요청 전부를 캐시 없이 새로 보냅니다.

**응답**
```json
{
  "region": "강원",
  "fetchedAt": "2026-09-08T05:00:00.000Z",
  "events": [
    {
      "name": "빵트레일런 2026",
      "date": "2026-09-12",
      "day": "토",
      "location": "정선 하이원 리조트",
      "distances": ["10km", "30km", "20km"],
      "status": "open",
      "deadline": "2026-09-12",
      "region": "강원",
      "type": "trail",
      "url": "https://marathonmate.store/race/109de8d9-a9df-4b0f-8d33-215e4efe1650"
    },
    {
      "name": "11월 강원 마라톤",
      "date": "2026-11-15",
      "day": "일",
      "location": "춘천종합운동장",
      "distances": ["하프", "10km"],
      "status": "pre_open",
      "deadline": "2026-11-10",
      "region": "강원",
      "type": "road",
      "url": "https://marathonmate.store/race/aaa11111-0000-0000-0000-000000000001"
    }
  ],
  "debug": {
    "htmlLength": 617829,
    "source": "races",
    "totalEventsFound": 2,
    "eventCount": 2,
    "fetchedStatuses": [
      { "status": "open", "ok": true },
      { "status": "pre_open", "ok": true },
      { "status": "closed", "ok": true }
    ]
  }
}
```

`debug.source`는 `"races"`(가장 정확한 자체 데이터 경로), `"jsonld"`(예비), `"ai"`(최후 예비),
`"none"`(전부 실패) 중 하나입니다. `debug.fetchedStatuses`는 접수전/접수중/접수마감 3개 요청이 각각
성공했는지를 보여줍니다. `status`는 `"open"`(접수중)/`"pre_open"`(접수예정)/`"closed"`(접수마감)/
`"unknown"`(확인 불가) 중 하나입니다. `url`은 대회 상세 페이지 링크로, 있으면 앱에서 "대회 상세페이지
열기" 버튼에 그대로 쓰입니다.

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
