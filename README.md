# 이건MOHW? (EGUN MOHW) — 시험 저장소

인수인계서 자동완성 프로그램 "이건MOHW?"를 팀이 함께 시험해 보는 저장소입니다.
첫 실험: **아동수당을 고르면 아동수당법 연혁이 화면에 나온다** (DB 없이 JSON 파일로).

## 폴더 구조

| 폴더 | 담는 것 | 담당 |
| --- | --- | --- |
| `web/` | 클레이 강의실 화면 (`index.html`) | 화면 담당 |
| `data/law/` | 법령 연혁 자료 (`law_data.js`) | 데이터 담당 |
| `data/fiscal/` | 예산 자료 (`fiscal_mohw.js`) | 데이터 담당 |
| `collectors/` | 자료 수집 스크립트 (`fetch_fiscal.py` 등) | 연결 담당 |
| `supabase/` | DB 표 만드는 SQL, Edge Function | 연결 담당 |
| `docs/` | 사용법·프롬프트·회의 메모 | 모두 |

## 팀 규칙 (꼭 지켜요)

1. **작업 전에 항상 받기(Pull)** — GitHub Desktop의 `Fetch origin` → `Pull origin`.
2. **한 파일은 한 사람만 고치기** — 화면은 화면 담당, 자료는 데이터 담당.
3. **키는 절대 올리지 않기** — API 키, `.env`, `tools/api_key.txt`는 `.gitignore`로 막혀 있어요. 카톡·메일로도 보내지 않아요.
4. **개인정보 저장 금지** — 보도자료 담당자 이름·전화번호 등은 자료에 넣지 않아요.
5. **올릴 때 한 줄 메모** — 예: `아동수당법 연혁 MCP 결과로 교체`.

## 첫 실험 하는 법

1. `docs/법령MCP_프롬프트.md`의 프롬프트를 법령 MCP가 연결된 Claude에 붙여 넣어요.
2. 나온 JSON으로 `data/law/law_data.js`의 예시 값을 통째로 바꿔요.
3. `web/index.html`을 더블클릭해서 열고, 업무에서 **아동수당**을 고르면 연혁 타임라인이 나와요.
4. 웹 주소로 공유하려면 Vercel 또는 Netlify에 이 저장소를 연결해요(비공개 저장소도 무료).

## 다음 단계

- 3단계: `supabase/law_events.sql`로 Supabase에 표를 만들고, 화면이 DB에서 읽게 바꾸기
- 4단계: Edge Function으로 법령 API 실시간 조회
