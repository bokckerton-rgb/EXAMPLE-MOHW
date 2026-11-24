// 법령 연혁 자료 — 화면(web/index.html)이 이 파일을 읽어요.
// ⚠ 지금 값은 형식을 보여주는 "예시"예요. 법령 MCP 결과로 통째로 바꿔 주세요.
// 칸 이름은 팀 데이터 공통규격의 events 표와 맞췄어요.
window.LAW_DATA = {
  observed_at: "2026-11-25",       // 자료를 받은 날
  source: "예시 (법령 MCP 결과로 교체 필요)",
  is_sample: true,
  policies: {
    "아동수당": {
      laws: ["아동수당법", "아동수당법 시행령"],
      events: [
        {
          law_name: "아동수당법",
          event_type: "제정",          // 제정 / 일부개정 / 전부개정 / 타법개정
          promulgated_on: "2018-03-27", // 공포일
          effective_on: "2018-09-01",   // 시행일
          summary: "예시 — 아동수당 지급 근거 마련",
          source_url: "https://www.law.go.kr",
          validation_status: "sample"
        },
        {
          law_name: "아동수당법",
          event_type: "일부개정",
          promulgated_on: "",
          effective_on: "",
          summary: "예시 — 지급 대상 연령 확대 (날짜는 MCP 결과로 채우기)",
          source_url: "https://www.law.go.kr",
          validation_status: "sample"
        }
      ]
    },
    "재난적의료비": {
      laws: ["재난적의료비 지원에 관한 법률"],
      events: []
    }
  }
};
