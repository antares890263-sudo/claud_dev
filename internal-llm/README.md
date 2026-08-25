# 사내 Ollama 연동 — 레이스 페이스 플래너

Anthropic API 같은 상용 API 없이, **사내망에 이미 설치된 Ollama**로 페이스 계획을 생성하는 방법입니다.
GitHub Actions의 self-hosted runner를 이용해서, 인바운드 포트를 하나도 열지 않고도 내부 서버를 호출합니다.

## 동작 방식

1. 트래커 앱에서 "입력 파일 내보내기" → `race-input.json` 다운로드
2. 이 파일을 저장소 루트에 커밋 & push
3. GitHub Actions 탭에서 `Generate Race Pace Plan (internal Ollama)` 워크플로우를 수동 실행 (Run workflow)
4. 사내 러너가 이 요청을 받아 로컬 Ollama(`http://localhost:11434`)를 호출
5. 결과를 `race-plan.json`으로 자동 커밋 & push
6. GitHub Pages가 재배포되면, 트래커 앱에서 "저장된 계획 불러오기"로 바로 읽어옴

브라우저가 사내망을 직접 두드리는 구간이 전혀 없습니다 — 전부 깃이 되는 경로로만 오갑니다.

## 설치

### 1. Self-hosted runner 등록
GitHub 저장소 → **Settings → Actions → Runners → New self-hosted runner**에서 안내하는 명령어를,
Ollama가 설치된 사내 서버에서 그대로 실행하세요. 마지막에 `run.sh`를 실행하면 러너가 대기 상태가 됩니다
(끊기지 않게 하려면 systemd 서비스로 등록하는 걸 권장 — 등록 스크립트가 안내해줍니다).

### 2. Ollama 모델 준비
```bash
ollama pull qwen2.5:7b
# 또는 llama3.1, mistral 등 사내에서 이미 검증된 모델
```

### 3. 워크플로우 파일 추가
이 폴더의 `.github/workflows/pace-plan.yml`을 저장소에 그대로 추가하고 push하세요.

### 4. 필요한 도구 확인
러너가 설치된 서버에 `jq`, `curl`이 있어야 합니다 (대부분의 Linux 서버엔 기본 설치되어 있음).
```bash
which jq curl || sudo apt-get install -y jq curl
```

## 실제 사용

1. 트래커 앱에서 GPX 업로드 → "레이스 페이스 계획" 패널에서 목표 입력 → **"입력 파일 내보내기"**
2. 다운로드된 `race-input.json`을 저장소 루트에 넣고 커밋 & push
3. GitHub 저장소 → **Actions** 탭 → **Generate Race Pace Plan** 워크플로우 선택 → **Run workflow** 클릭
   (필요하면 모델 이름, Ollama 주소 등을 입력창에서 바꿀 수 있음)
4. 1~2분 후 완료되면 `race-plan.json`이 자동으로 커밋됨
5. 트래커 앱에서 **"저장된 계획 불러오기"** 클릭 → 표가 뜸

## ⚠️ 보안 주의사항

- **이 저장소는 반드시 Private로 유지하세요.** Self-hosted runner는 워크플로우가 실행되는 동안 사내망에 접근할 수 있는 상태가 되는데, Public 저장소에 self-hosted runner를 연결하면 **누구나 Pull Request를 통해 그 러너에서 임의 코드를 실행시킬 수 있는 심각한 보안 위험**이 있습니다 (GitHub 공식 문서도 이 조합을 명시적으로 경고합니다).
- `workflow_dispatch`는 기본적으로 저장소에 쓰기 권한이 있는 사람만 실행할 수 있어서, 본인 혼자 쓰는 개인 저장소라면 이 흐름 자체는 안전합니다.
- Ollama 서버가 사내망 안의 다른 민감한 자원에 접근 가능하다면, 러너 계정의 권한을 최소화해두는 걸 권장합니다.
