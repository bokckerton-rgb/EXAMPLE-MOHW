# law-rank · OpenRouter 주요 개정 추천 단독 테스트

HTML에 버튼을 붙이기 전에 **서버에서 OpenRouter 호출만** 확인하는 함수입니다.
- 추천(후보 ID · 중요도 1~5 · 한 줄 선정 사유)만 돌려주고, **확정 연혁·후보 표를 바꾸지 않습니다**(읽기만).
- 시행일·공포일·원문 링크(`facts`)는 AI가 아니라 `law_revision_candidates`(법제처 값)에서 붙입니다.
- 첫 테스트 모델: `openrouter/free` (Secrets 의 `OPENROUTER_RANK_MODEL` 로 바꿀 수 있고, 요청에 `"model"` 을 넣으면 그 요청만 바뀝니다)
- 호출 권한: 서버에서 확인 — 서버용 키(service_role) 또는 팀 코드(`x-team-code` 헤더). HTML 연결 때는 팀 코드를 씁니다.
- `OPENROUTER_API_KEY` 는 Secrets 에서만 읽고, 코드·로그·응답에 넣지 않습니다(오류 문구에 섞여 와도 `***` 로 지움).

> Example project 에는 이미 `law-rank` 가 배포돼 있어요(JWT 검증 꺼짐). 다른 프로젝트라면 **Edge Functions → Deploy a new function → Via Editor**, 이름 `law-rank`, `index.ts` 붙여 넣기 → Deploy → **Details** 에서 *Verify JWT* 끄기.

## Test 창 공통 설정
함수 `law-rank` → **Test**
- HTTP Method: `POST`
- Authorization(Role): **service_role** (선택지가 없으면 Headers에 `Authorization: Bearer <Legacy service_role 키>`)
- Headers: `Content-Type: application/json`

---

## 테스트 0 (권장) · 실제 후보를 DB에 먼저 저장
`facts`(시행일·공포일·원문 링크)를 받으려면 후보가 `law_revision_candidates` 에 있어야 해요. 지금 Example project 의 후보 표는 **비어 있습니다**.
1. 함수 `law-history-sync` → Test (위와 같은 설정), Body:
```json
{ "task_id": "child-allowance", "max_pairs": 12, "include_future": true }
```
2. SQL Editor 에서 후보 ID 확인:
```sql
select id, candidate_key, to_ef_yd, revision_type, added_count, modified_count, deleted_count
from public.law_revision_candidates
where task_id = 'child-allowance'
order by to_ef_yd;
```
`to_ef_yd = 2026-09-10`, `revision_type = 타법개정` 인 줄의 `id`(제10조의2 신설)를 복사해 두세요.

## 테스트 1 · 후보를 직접 넣어 OpenRouter 호출 (말씀하신 형태)
`<제10조의2 후보 id>` 자리에 위에서 복사한 id 를 넣으세요. 두 번째 후보는 "기관 명칭 변경" 처럼 덜 중요한 예시예요(DB에 없는 ID라 facts 가 비어 나오는 것도 함께 확인).
```json
{
  "task_id": "child-allowance",
  "candidates": [
    {
      "candidate_id": "<제10조의2 후보 id>",
      "changed_articles": [
        {
          "article": "제10조의2",
          "title": "첫만남이용권 지급",
          "change_label": "신설",
          "before_text": "",
          "after_text": "제10조의2(첫만남이용권 지급) ① 국가와 지방자치단체는 아동 양육에 따른 경제적 부담을 경감하기 위하여 200만원 이상의 첫만남이용권(이하 \"이용권\"이라 한다)을 출생아동에게 지급할 수 있다. ③ 이용권을 지급받으려는 보호자 또는 보건복지부장관이 정하는 보호자의 대리인은 출생아동의 주민등록 주소지 관할 특별자치시장ㆍ특별자치도지사ㆍ시장ㆍ군수ㆍ구청장에게 이용권의 지급을 신청할 수 있다."
        }
      ]
    },
    {
      "candidate_id": "demo-name-change",
      "changed_articles": [
        {
          "article": "제22조",
          "title": "자료 및 정보의 수집 등",
          "change_label": "개정",
          "before_text": "제22조 … 사회보장정보원에 …",
          "after_text": "제22조 … 한국사회보장정보원에 …"
        }
      ]
    }
  ]
}
```

### 예상 응답 (모양 · 값은 모델에 따라 달라요)
```json
{
  "ok": true,
  "task_id": "child-allowance",
  "model_requested": "openrouter/free",
  "model_used": "<OpenRouter 가 실제로 고른 무료 모델 이름>",
  "elapsed_ms": 8000,
  "usage": { "prompt_tokens": 700, "completion_tokens": 80 },
  "input_count": 2,
  "ai_returned": 1,
  "recommendations": [
    {
      "candidate_id": "<제10조의2 후보 id>",
      "importance": 4,
      "reason": "제10조의2 신설로 출생아동 첫만남이용권 지급 근거와 신청 절차가 생김",
      "changed_articles": ["제10조의2 신설"],
      "facts": {
        "candidate_key": "013103:284619@20260327>286729@20260910",
        "law_name": "아동수당법",
        "effective_date": "2026-09-10",
        "promulgation_date": "2026-06-09",
        "promulgation_no": "21777",
        "revision_type": "타법개정",
        "is_future": false,
        "source_url": "https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=286729&efYd=20260910",
        "previous_source_url": "https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=284619&efYd=20260327"
      }
    }
  ],
  "dropped": [],
  "notes": ["확정 연혁과 후보 표는 바꾸지 않았어요(추천만 반환).", "시행일·공포일·원문 링크(facts)는 law_revision_candidates 의 법제처 값이에요."]
}
```
**성공 기준**
- 상태 200, `ok: true`, `model_requested: "openrouter/free"`
- `recommendations` 가 0~10건이고, 각 `candidate_id` 가 입력 목록 안에 있음
- 제10조의2 후보가 추천되면 `facts.effective_date = 2026-09-10`, `promulgation_date = 2026-06-09`, `source_url` 이 law.go.kr 링크 (테스트 0을 건너뛰었다면 `facts: null` + notes 안내)
- 명칭만 바뀐 `demo-name-change` 는 빠지거나 importance 1~2 (모델 판단이라 달라질 수 있음)
- 응답 어디에도 OpenRouter 키가 없음
- SQL `select count(*) from law_history_confirmations;` 결과가 테스트 전후로 같음(확정 연혁 안 바뀜)

## 테스트 2 · DB에 저장된 후보 전체로 추천 (테스트 0 이후)
```json
{ "task_id": "child-allowance" }
```
- `input_count` = 바뀐 조문이나 부칙이 있는 후보 수(아동수당법은 8건 안팎), 모든 추천에 `facts` 가 채워짐

## 테스트 3 · 검증 규칙만 확인 (OpenRouter 를 부르지 않음, 무료 한도 절약)
AI 답 대신 `test_ai_content` 문자열로 검증만 시험합니다(서버 키·팀 코드로만 가능).
```json
{
  "task_id": "child-allowance",
  "candidates": [
    { "candidate_id": "A", "changed_articles": [{ "article": "제4조", "change_label": "개정", "before_text": "8세 미만", "after_text": "13세 미만" }] },
    { "candidate_id": "B", "changed_articles": [{ "article": "제22조", "change_label": "개정", "before_text": "사회보장정보원", "after_text": "한국사회보장정보원" }] }
  ],
  "test_ai_content": "{\"recommendations\":[{\"candidate_id\":\"A\",\"importance\":5,\"reason\":\"제4조 지급 대상 연령 확대\"},{\"candidate_id\":\"A\",\"importance\":5,\"reason\":\"중복\"},{\"candidate_id\":\"Z\",\"importance\":5,\"reason\":\"없는 후보\"}]}"
}
```
예상: `recommendations` 에 A 1건, `dropped` 에 `{"candidate_id":"A","why":"중복 ID"}`, `{"candidate_id":"Z","why":"입력 목록에 없는 ID"}`. (11건 이상을 넣으면 중요도 낮은 것부터 `"최대 10건 초과"` 로 빠짐)

## 오류 응답
| 상태·코드 | 뜻 / 조치 |
|---|---|
| 401 `NEED_TEAM_OR_SERVER` | Test 창 Authorization 을 service_role 로 |
| 500 `NO_OPENROUTER_KEY` | Secrets 에 `OPENROUTER_API_KEY` 이름 확인 |
| 502 `OPENROUTER_HTTP_401` | OpenRouter 키가 틀림 |
| 502 `OPENROUTER_HTTP_429` | 무료 모델 한도. 잠시 뒤 다시 |
| 502 `AI_BAD_FORMAT` | 무료 모델이 JSON 대신 글을 씀. 다시 시도하거나 `"model"` 을 다른 모델로 |
| 504 `OPENROUTER_UNREACHABLE` | 90초 초과. 다시 시도 |
| 404 `NO_CANDIDATES` | candidates 를 넣거나 테스트 0 먼저 |

## HTML 연결 때
`law-rank` 는 테스트용이고, 홈페이지 연결은 같은 검증 규칙을 쓰는 `law-history-review`(review → confirm)가 맡습니다. 두 함수 모두 팀 코드를 **서버에서** 확인합니다(`TEAM_REVIEW_CODE` Secret).
