# 법령 MCP로 연혁 받기 — 복사해서 쓰는 프롬프트

법령 MCP가 연결된 Claude 대화에 아래를 붙여 넣으세요. `아동수당` 부분만 바꾸면 다른 정책도 돼요.

```
법령 MCP로 「아동수당법」과 「아동수당법 시행령」의 개정 연혁을 모두 조회해 줘.
아래 형식의 JavaScript 파일 내용으로만 답해 줘. 설명은 빼고.

- 개정 1건 = events 배열의 한 줄
- law_name: 법령명
- event_type: 제정 / 일부개정 / 전부개정 / 타법개정 중 하나
- promulgated_on: 공포일 (YYYY-MM-DD)
- effective_on: 시행일 (YYYY-MM-DD)
- summary: 주요 개정내용 한 줄 (MCP 결과에 근거, 없으면 빈칸)
- source_url: 원문 링크
- validation_status: "auto_extracted"
- 지어내지 말고, MCP 결과에 없는 칸은 빈 문자열("")로 둬.
- 오래된 것부터 날짜순으로.

형식:
window.LAW_DATA = {
  observed_at: "오늘 날짜",
  source: "국가법령정보 (법령 MCP)",
  is_sample: false,
  policies: {
    "아동수당": { laws: [...], events: [ ... ] },
    "재난적의료비": { laws: ["재난적의료비 지원에 관한 법률"], events: [ ... ] }
  }
};
```

## 받은 뒤 할 일

1. 결과 전체를 `data/law/law_data.js`에 덮어쓰기
2. `web/index.html`을 열어 아동수당 → 연혁이 날짜순으로 나오는지 확인
3. 연혁이 1건만 나오면 → MCP에 연혁 조회 기능이 없는 것. 팀 채팅에 공유
4. GitHub Desktop에서 Commit(메모: `아동수당법 연혁 MCP 결과로 교체`) → Push
