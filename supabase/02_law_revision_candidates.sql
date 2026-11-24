-- =====================================================================
-- 02_law_revision_candidates.sql  ·  개정 후보 저장소
-- Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여 넣고 Run.
-- 여러 번 실행해도 안전합니다. task_laws·task_law_articles 는 건드리지 않습니다.
-- =====================================================================

-- 개정 후보 1건 = 한 법령의 "이전 버전 → 다음 버전" 변화 1번
create table if not exists public.law_revision_candidates (
  id                       uuid        primary key default gen_random_uuid(),
  task_id                  text        not null,               -- 예: child-allowance
  law_id                   text        not null check (law_id ~ '^[0-9]{6}$'),  -- 예: 013103 (앞자리 0 유지)
  law_name                 text        not null,
  candidate_key            text        not null,               -- 013103:284619@20260327>286729@20260910
  from_mst                 text        not null,               -- 비교 기준(이전) 버전 법령일련번호
  from_ef_yd               date        not null,               -- 이전 버전 시행일
  to_mst                   text        not null,               -- 개정된(다음) 버전 법령일련번호
  to_ef_yd                 date        not null,               -- 개정 시행일
  promulgation_date        date,                               -- 공포일
  promulgation_no          text,                               -- 공포번호(법률 제○호)
  revision_type            text,                               -- 일부개정 / 타법개정 / 전부개정 …
  is_future                boolean     not null default false, -- 시행예정 여부
  source_url               text        not null,               -- 개정 후 원문 링크(국가법령정보센터)
  previous_source_url      text,                               -- 개정 전 원문 링크
  added_count              integer     not null default 0,
  modified_count           integer     not null default 0,
  deleted_count            integer     not null default 0,
  changed_articles         jsonb       not null default '[]'::jsonb,  -- 조문별 전후 문구
  supplementary_provisions jsonb       not null default '[]'::jsonb,  -- 관련 부칙
  content_hash             text        not null,               -- 내용이 바뀌었는지 판단용
  status                   text        not null default 'collected',  -- 4단계 평가 상태(이번엔 collected 만 씀)
  first_seen_at            timestamptz not null default now(),
  last_synced_at           timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- 같은 업무에서 같은 개정(버전 쌍)은 한 줄만: 다시 실행해도 중복 저장 안 됨
create unique index if not exists law_revision_candidates_task_key
  on public.law_revision_candidates (task_id, candidate_key);

-- 업무별 최신 개정 순 조회용
create index if not exists law_revision_candidates_task_date
  on public.law_revision_candidates (task_id, to_ef_yd desc);

-- 브라우저에서 직접 읽기·쓰기 금지 (서버 함수만 접근)
alter table public.law_revision_candidates enable row level security;

-- 확인: 표가 만들어졌는지 (처음엔 0)
select count(*) as candidate_rows from public.law_revision_candidates;
