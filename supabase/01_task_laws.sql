-- =====================================================================
-- 01_task_laws.sql  ·  업무 ↔ 법령 연결 등록
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여 넣고 Run 하세요.
-- 여러 번 실행해도 같은 연결이 두 줄로 늘어나지 않습니다.
-- 기존 task_law_articles 테이블은 이 파일에서 전혀 건드리지 않습니다.
-- =====================================================================

-- 1) 테이블: 업무 1개 + 법령 1개 = 1행
create table if not exists public.task_laws (
  task_id    text        not null,   -- 홈페이지 업무 ID (예: child-allowance)
  law_id     text        not null,   -- 법제처 법령 ID. 앞자리 0을 지키려고 문자(text)로 저장
  law_name   text        not null,   -- 사람이 읽는 법령명
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 예전에 다른 모양으로 만들어 둔 task_laws 가 있어도 필요한 칸만 보충
alter table public.task_laws add column if not exists created_at timestamptz not null default now();
alter table public.task_laws add column if not exists updated_at timestamptz not null default now();

-- 2) 같은 (업무, 법령) 조합은 한 번만 들어가게 하는 규칙
create unique index if not exists task_laws_task_id_law_id_key
  on public.task_laws (task_id, law_id);

-- 3) 법령 ID는 숫자 6자리 문자만 허용 (013103 → 13103 으로 잘리는 실수 방지)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_laws_law_id_6digits') then
    alter table public.task_laws
      add constraint task_laws_law_id_6digits check (law_id ~ '^[0-9]{6}$');
  end if;
end $$;

-- 4) 보안: 브라우저에서 직접 읽지 못하게 잠그고, 서버(Edge Function)만 읽음
alter table public.task_laws enable row level security;

-- 5) 아동수당 업무 ↔ 아동수당법 연결 (다시 실행하면 법령명만 최신으로 덮어씀)
insert into public.task_laws (task_id, law_id, law_name)
values ('child-allowance', '013103', '아동수당법')
on conflict (task_id, law_id)
do update set law_name = excluded.law_name,
              updated_at = now();

-- 6) 확인: 결과 창에 child-allowance | 013103 | 아동수당법 한 줄이 보이면 성공
select task_id, law_id, law_name, updated_at
from public.task_laws
order by task_id, law_id;
