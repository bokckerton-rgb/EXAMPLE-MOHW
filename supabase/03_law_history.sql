-- =====================================================================
-- 03_law_history.sql  ·  4단계 주요 개정 검토·확정 연혁
-- 먼저 02_law_revision_candidates.sql(3단계)이 실행돼 있어야 합니다.
-- Supabase 대시보드 > SQL Editor > New query 에 통째로 붙여 넣고 Run.
-- 여러 번 실행해도 안전합니다. 기존 표(task_laws, law_revision_candidates)는 바꾸지 않습니다.
-- =====================================================================

-- 1) AI 검토 기록: '주요 개정 검토'를 누를 때마다 1줄 (실패해도 기록, 확정 연혁에는 영향 없음)
create table if not exists public.law_revision_reviews (
  id               uuid        primary key default gen_random_uuid(),
  task_id          text        not null,
  status           text        not null check (status in ('succeeded', 'failed')),
  model            text,                                   -- OpenRouter 모델 이름
  candidate_ids    jsonb       not null default '[]'::jsonb, -- AI에 보낸 실제 후보 ID
  recommendations  jsonb       not null default '[]'::jsonb, -- 검증을 통과한 추천 [{candidate_id, importance, reason}]
  dropped          jsonb       not null default '[]'::jsonb, -- 검증에서 걸러진 항목(없는 ID·중복·10건 초과)
  requested_by     text,
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists law_revision_reviews_task on public.law_revision_reviews (task_id, created_at desc);

-- 2) 확정 연혁(판): '연혁 확정'을 누를 때마다 새 판 1줄. 업무마다 현재 판은 하나뿐
create table if not exists public.law_history_confirmations (
  id            uuid        primary key default gen_random_uuid(),
  task_id       text        not null,
  version_no    integer     not null,
  review_id     uuid        references public.law_revision_reviews(id) on delete set null,
  model         text,
  confirmed_by  text        not null,
  confirmed_at  timestamptz not null default now(),
  item_count    integer     not null,
  is_current    boolean     not null default true,
  constraint law_history_confirmations_version unique (task_id, version_no)
);
create unique index if not exists law_history_confirmations_one_current
  on public.law_history_confirmations (task_id) where is_current;

-- 3) 확정 연혁 항목: 확정 순간의 법제처 값(공포일·시행일·원문 링크)을 그대로 복사해 둠
--    → 홈페이지와 HWPX가 같은 판의 같은 값을 씀
create table if not exists public.law_history_items (
  id                   uuid        primary key default gen_random_uuid(),
  confirmation_id      uuid        not null references public.law_history_confirmations(id) on delete cascade,
  sort_order           integer     not null,            -- 시행일순
  candidate_id         uuid        references public.law_revision_candidates(id) on delete set null,
  candidate_key        text        not null,
  law_id               text        not null,
  law_name             text        not null,
  effective_date       date        not null,            -- 시행일 (법제처)
  promulgation_date    date,                            -- 공포일 (법제처)
  promulgation_no      text,                            -- 공포번호 (법제처)
  revision_type        text,                            -- 일부개정·타법개정 … (법제처)
  changed_summary      text        not null,            -- 예: 제10조의2 신설 (법제처 비교 결과로 계산)
  importance           smallint    not null check (importance between 1 and 5),  -- AI 추천 중요도
  reason               text        not null,            -- AI 한 줄 선정 사유(팀원이 확인)
  source_url           text        not null,            -- 원문 링크 (법제처)
  previous_source_url  text,
  constraint law_history_items_unique unique (confirmation_id, candidate_key)
);
create index if not exists law_history_items_conf on public.law_history_items (confirmation_id, sort_order);

-- 4) 임시 검토 권한(선택): 새 팀원·테스트용으로 기한이 있는 코드를 해시로만 저장
--    기본 팀 코드는 Edge Functions > Secrets 의 TEAM_REVIEW_CODE 를 씁니다.
create table if not exists public.review_access_tokens (
  id          uuid        primary key default gen_random_uuid(),
  label       text        not null,
  token_hash  text        not null unique,             -- sha256(코드) 16진수. 원문은 저장 안 함
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- 5) 확정 저장은 한 번에(전부 성공 또는 전부 취소). 실패하면 기존 현재 판이 그대로 남음
create or replace function public.confirm_law_history(
  p_task_id text, p_review_id uuid, p_model text, p_confirmed_by text, p_items jsonb
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_ver integer;
  v_cnt integer := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
begin
  if v_cnt < 1 or v_cnt > 10 then
    raise exception '확정 항목은 1~10건이어야 합니다 (현재 %건)', v_cnt;
  end if;
  perform pg_advisory_xact_lock(hashtext('law_history:' || p_task_id));  -- 동시 확정 방지
  select coalesce(max(version_no), 0) + 1 into v_ver
    from law_history_confirmations where task_id = p_task_id;
  update law_history_confirmations set is_current = false
    where task_id = p_task_id and is_current;
  insert into law_history_confirmations (task_id, version_no, review_id, model, confirmed_by, item_count, is_current)
    values (p_task_id, v_ver, p_review_id, p_model, p_confirmed_by, v_cnt, true)
    returning id into v_id;
  insert into law_history_items (
    confirmation_id, sort_order, candidate_id, candidate_key, law_id, law_name, effective_date,
    promulgation_date, promulgation_no, revision_type, changed_summary, importance, reason,
    source_url, previous_source_url)
  select v_id, x.sort_order, x.candidate_id, x.candidate_key, x.law_id, x.law_name, x.effective_date,
         x.promulgation_date, x.promulgation_no, x.revision_type, x.changed_summary, x.importance, x.reason,
         x.source_url, x.previous_source_url
  from jsonb_to_recordset(p_items) as x(
    sort_order int, candidate_id uuid, candidate_key text, law_id text, law_name text, effective_date date,
    promulgation_date date, promulgation_no text, revision_type text, changed_summary text, importance smallint,
    reason text, source_url text, previous_source_url text);
  return v_id;
end $$;

-- 서버(Edge Function의 서버 키)만 호출 가능
revoke all on function public.confirm_law_history(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_law_history(text, uuid, text, text, jsonb) to service_role;

-- 6) 보안: 브라우저에서 직접 읽기·쓰기 금지 (모든 접근은 Edge Function 경유)
alter table public.law_revision_reviews      enable row level security;
alter table public.law_history_confirmations enable row level security;
alter table public.law_history_items         enable row level security;
alter table public.review_access_tokens      enable row level security;

-- 확인: 네 개 표가 보이면 성공
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('law_revision_reviews','law_history_confirmations','law_history_items','review_access_tokens')
order by table_name;
