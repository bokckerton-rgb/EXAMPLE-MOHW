-- =====================================================================
-- 04_law_history_display.sql  ·  화면 B(연도별 변화 요약)·HWPX C(표)용 칸 추가
-- 03_law_history.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 기존 확정본(판)은 그대로 두고, 새로 확정하는 판부터 새 칸이 채워집니다.
-- =====================================================================

-- 확정 항목에 분야·짧은 제목·전→후 문구 칸 추가
alter table public.law_history_items add column if not exists areas    text[] not null default '{}';  -- 지원 대상 / 지급액 / 신청·지급 절차 / 경과조치 / 기타
alter table public.law_history_items add column if not exists headline text;                         -- 예: 13세 미만으로 확대
alter table public.law_history_items add column if not exists changes  jsonb  not null default '[]'::jsonb; -- [{item, before, after}]

-- 확정 함수: 새 칸도 함께 저장 (이름·입력은 그대로라 서버 함수 호출 방식은 같음)
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
  perform pg_advisory_xact_lock(hashtext('law_history:' || p_task_id));
  select coalesce(max(version_no), 0) + 1 into v_ver from law_history_confirmations where task_id = p_task_id;
  update law_history_confirmations set is_current = false where task_id = p_task_id and is_current;
  insert into law_history_confirmations (task_id, version_no, review_id, model, confirmed_by, item_count, is_current)
    values (p_task_id, v_ver, p_review_id, p_model, p_confirmed_by, v_cnt, true)
    returning id into v_id;
  insert into law_history_items (
    confirmation_id, sort_order, candidate_id, candidate_key, law_id, law_name, effective_date,
    promulgation_date, promulgation_no, revision_type, changed_summary, importance, reason,
    source_url, previous_source_url, areas, headline, changes)
  select v_id, x.sort_order, x.candidate_id, x.candidate_key, x.law_id, x.law_name, x.effective_date,
         x.promulgation_date, x.promulgation_no, x.revision_type, x.changed_summary, x.importance, x.reason,
         x.source_url, x.previous_source_url, coalesce(x.areas, '{}'), x.headline, coalesce(x.changes, '[]'::jsonb)
  from jsonb_to_recordset(p_items) as x(
    sort_order int, candidate_id uuid, candidate_key text, law_id text, law_name text, effective_date date,
    promulgation_date date, promulgation_no text, revision_type text, changed_summary text, importance smallint,
    reason text, source_url text, previous_source_url text, areas text[], headline text, changes jsonb);
  return v_id;
end $$;

revoke all on function public.confirm_law_history(text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.confirm_law_history(text, uuid, text, text, jsonb) to service_role;

-- 확인: areas, headline, changes 세 줄이 보이면 성공
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'law_history_items' and column_name in ('areas', 'headline', 'changes');
