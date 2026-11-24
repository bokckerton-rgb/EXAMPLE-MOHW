-- 3단계용: Supabase SQL Editor에 붙여 넣고 Run
-- 법령 연혁 표 (팀 데이터 공통규격 events와 같은 칸)

create table if not exists law_events (
  id                bigint generated always as identity primary key,
  policy_name       text not null,            -- 예: 아동수당
  law_name          text not null,            -- 예: 아동수당법
  event_type        text,                     -- 제정 / 일부개정 / 전부개정 / 타법개정
  promulgated_on    date,                     -- 공포일
  effective_on      date,                     -- 시행일
  summary           text,                     -- 주요 개정내용 한 줄
  source_url        text,                     -- 원문 링크
  validation_status text default 'auto_extracted', -- auto_extracted / verified / sample
  observed_at       timestamptz default now(),
  unique (law_name, promulgated_on, event_type)   -- 같은 개정을 두 번 넣지 않기
);

-- 화면은 읽기만 가능, 쓰기는 서버(service_role)만
alter table law_events enable row level security;

create policy "누구나 읽기" on law_events
  for select using (true);
