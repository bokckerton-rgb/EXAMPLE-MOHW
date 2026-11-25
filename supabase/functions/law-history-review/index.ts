// =====================================================================
// Supabase Edge Function: law-history-review  (4단계 · 주요 개정 검토·확정)
//
// POST { "action": ..., "task_id": "child-allowance", ... }
//   current : 현재 확정 연혁(홈페이지·HWPX 공용)          — 홈페이지 공개 키(apikey)로 호출
//   sync    : 개정 후보만 다시 수집(law-history-sync 재사용)  — 팀 코드 필요
//   review  : 후보 수집 → OpenRouter 추천 → 검증 → 검토 기록   — 팀 코드 필요 (AI는 여기서만 호출)
//   confirm : 팀원이 고른 추천 항목으로 새 확정 연혁 저장      — 팀 코드 필요
//
// Secrets(Edge Functions > Secrets):
//   OPENROUTER_API_KEY  OpenRouter 키 (HTML·GitHub 에 넣지 않음)
//   OPENROUTER_MODEL    사용할 모델 이름 (비우면 openrouter/auto)
//   TEAM_REVIEW_CODE    팀원 검토 코드 (6자 이상)
// 자동 제공: SUPABASE_URL, SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEYS / SUPABASE_ANON_KEY
// 공포일·시행일·원문 링크는 AI가 아니라 law_revision_candidates(법제처 값)에서만 가져옵니다.
// =====================================================================

const MAX_ITEMS = 10;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-team-code',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

class UserError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const env = (n: string): string => (globalThis as any).Deno?.env?.get(n) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function sameText(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------- Supabase REST (서버 키) ----------------
function serverHeaders(): Record<string, string> {
  let secret = '';
  try { secret = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default ?? ''; } catch { /* 무시 */ }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!env('SUPABASE_URL') || (!secret && !legacy)) throw new UserError(500, 'SERVER_CONFIG', '서버 설정(Supabase 키)이 비어 있어요.');
  return secret ? { apikey: secret } : { apikey: legacy, Authorization: `Bearer ${legacy}` };
}
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init, headers: { ...serverHeaders(), 'Content-Type': 'application/json', ...(init.headers as any) },
  });
  const t = await res.text();
  if (!res.ok) {
    const missing = res.status === 404 || /does not exist|Could not find/i.test(t);
    throw new UserError(500, 'DB_ERROR', missing
      ? '필요한 표나 함수가 없어요. 02·03 SQL을 먼저 실행해 주세요.'
      : `DB 작업 실패(HTTP ${res.status}): ${cut(t.replace(/\s+/g, ' '), 160)}`);
  }
  return t ? JSON.parse(t) : null;
}

// ---------------- 호출자 확인 ----------------
function isPublicCaller(req: Request): boolean {
  const sent = req.headers.get('apikey') ?? '';
  const keys: string[] = [];
  try { keys.push(...Object.values(JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') || '{}')).map(String)); } catch { /* 무시 */ }
  if (env('SUPABASE_ANON_KEY')) keys.push(env('SUPABASE_ANON_KEY'));
  return keys.length === 0 || keys.includes(sent);
}
function isServerCaller(req: Request): boolean {
  const sent = [req.headers.get('apikey') ?? '', (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')].filter(Boolean);
  const allowed: string[] = [];
  try { allowed.push(...Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}')).map(String)); } catch { /* 무시 */ }
  if (env('SUPABASE_SERVICE_ROLE_KEY')) allowed.push(env('SUPABASE_SERVICE_ROLE_KEY'));
  return allowed.length > 0 && sent.some((s) => allowed.includes(s));
}
async function isTeamCaller(req: Request): Promise<boolean> {
  const code = (req.headers.get('x-team-code') ?? '').trim();
  if (code.length < 6) return false;
  if (sameText(code, env('TEAM_REVIEW_CODE').trim())) return true;
  try {
    const rows = await rest(`review_access_tokens?select=id&token_hash=eq.${await sha256(code)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}
async function requireTeam(req: Request) {
  if (isServerCaller(req) || await isTeamCaller(req)) return;
  await new Promise((r) => setTimeout(r, 800)); // 무작위 대입 늦추기
  throw new UserError(401, 'NEED_TEAM_CODE', '팀 코드가 맞지 않아요. 검토와 확정은 팀원만 할 수 있어요.');
}

// ---------------- 후보 → 화면·AI용 요약 ----------------
type Candidate = {
  id: string; task_id: string; law_id: string; law_name: string; candidate_key: string;
  to_ef_yd: string; promulgation_date: string | null; promulgation_no: string | null; revision_type: string | null;
  is_future: boolean; source_url: string; previous_source_url: string | null;
  added_count: number; modified_count: number; deleted_count: number;
  changed_articles: any[]; supplementary_provisions: any[];
};
const CAND_COLS = 'id,task_id,law_id,law_name,candidate_key,to_ef_yd,promulgation_date,promulgation_no,revision_type,is_future,source_url,previous_source_url,added_count,modified_count,deleted_count,changed_articles,supplementary_provisions';

/** 예: "제10조의2 신설" / "제4조·제6조 개정, 제8조 삭제 외 3개 조문" (법제처 비교 결과로 계산) */
export function changedSummary(c: Pick<Candidate, 'changed_articles' | 'supplementary_provisions'>): string {
  const arts = Array.isArray(c.changed_articles) ? c.changed_articles : [];
  if (!arts.length) return (c.supplementary_provisions?.length ? '부칙만 변경' : '조문 변경 없음');
  const shown = arts.slice(0, 5);
  const groups: { label: string; list: string[] }[] = [];
  for (const a of shown) {
    const label = a.change_label || '변경';
    const g = groups.find((x) => x.label === label);
    if (g) g.list.push(a.article); else groups.push({ label, list: [a.article] });
  }
  const text = groups.map((g) => `${g.list.join('·')} ${g.label}`).join(', ');
  return arts.length > shown.length ? `${text} 외 ${arts.length - shown.length}개 조문` : text;
}
const isUseful = (c: Candidate) => (c.changed_articles?.length ?? 0) > 0 || (c.supplementary_provisions?.length ?? 0) > 0;
const isFutureNow = (c: { to_ef_yd?: string; effective_date?: string }) => String(c.to_ef_yd ?? c.effective_date ?? '') > todayKst();

function evidence(c: Candidate) {
  const arts = c.changed_articles ?? [];
  return {
    articles: arts.slice(0, 8).map((a: any) => ({
      article: a.article, title: a.title, change_label: a.change_label,
      before_text: cut(a.before_text, 1500), after_text: cut(a.after_text, 1500),
    })),
    more_articles: Math.max(0, arts.length - 8),
    addenda: (c.supplementary_provisions ?? []).slice(0, 2).map((s: any) => ({ title: s.title, text: cut(s.text, 1500) })),
  };
}
function factsOf(c: Candidate) {
  return {
    candidate_id: c.id, candidate_key: c.candidate_key, law_id: c.law_id, law_name: c.law_name,
    effective_date: c.to_ef_yd, promulgation_date: c.promulgation_date, promulgation_no: c.promulgation_no,
    revision_type: c.revision_type, is_future: isFutureNow(c), changed_summary: changedSummary(c),
    source_url: c.source_url, previous_source_url: c.previous_source_url,
  };
}

// ---------------- OpenRouter ----------------
const SYSTEM_PROMPT = [
  '당신은 보건복지부 규제개혁법무담당관의 업무 인수인계를 돕는 법령 개정 분석가입니다.',
  '입력은 법제처 시행일 기준 버전을 비교해 얻은 개정 후보 목록입니다. 각 후보에는 바뀐 조문의 개정 전·후 문구와 관련 부칙이 있습니다.',
  '후임자가 꼭 알아야 할 주요 개정을 고르세요. 다음에 영향이 큰 개정을 우선합니다:',
  '① 지원 대상(연령·자격) ② 지급액 ③ 신청·지급 절차 ④ 경과조치·적용례·특례(부칙).',
  '용어 정비, 기관 명칭 변경, 인용 조문 정리만 있는 개정은 낮게 평가하거나 고르지 마세요.',
  '규칙:',
  '- candidate_id 는 입력에 있는 값을 한 글자도 바꾸지 말고 그대로 쓰세요. 같은 ID를 두 번 쓰지 마세요.',
  '- 최대 10건. 중요한 개정이 적으면 적게 고르세요(억지로 채우지 마세요).',
  '- importance 는 5(매우 큼)~1(작음) 정수입니다.',
  '- reason 은 근거 조문을 들어 한국어 한 문장(80자 이내)으로 쓰세요. 입력에 없는 사실·숫자·날짜를 만들지 마세요.',
  '출력은 JSON 하나만: {"recommendations":[{"candidate_id":"…","importance":5,"reason":"…"}]}',
].join('\n');

function aiInput(cands: Candidate[]) {
  return cands.map((c) => ({
    candidate_id: c.id,
    법령: c.law_name,
    공포일: c.promulgation_date, 시행일: c.to_ef_yd, 공포번호: c.promulgation_no, 개정구분: c.revision_type,
    시행예정: isFutureNow(c),
    바뀐조문: (c.changed_articles ?? []).slice(0, 8).map((a: any) => ({
      조문: a.article, 제목: a.title, 구분: a.change_label,
      개정전: cut(a.before_text, 600), 개정후: cut(a.after_text, 600),
    })),
    그밖의바뀐조문수: Math.max(0, (c.changed_articles ?? []).length - 8),
    관련부칙: (c.supplementary_provisions ?? []).slice(0, 2).map((s: any) => cut(`${s.title}\n${s.text}`, 900)),
  }));
}

async function askOpenRouter(cands: Candidate[]): Promise<{ model: string; raw: string }> {
  const key = env('OPENROUTER_API_KEY').trim();
  if (!key) throw new UserError(500, 'NO_OPENROUTER_KEY', '서버에 OpenRouter 키(OPENROUTER_API_KEY)가 없어요. Edge Functions > Secrets 에 등록해 주세요.');
  const model = env('OPENROUTER_MODEL').trim() || 'openrouter/auto';
  const scrub = (s: string) => s.split(key).join('***');
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'MOHW handoff law history' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 2500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ 후보: aiInput(cands) }) },
        ],
      }),
    });
  } catch (e) {
    throw new UserError(504, 'OPENROUTER_UNREACHABLE', (e as Error)?.name === 'TimeoutError'
      ? 'OpenRouter 응답이 90초 안에 오지 않았어요. 잠시 뒤 다시 검토해 주세요.' : 'OpenRouter에 연결하지 못했어요.');
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.parse(body)?.error?.message ?? ''; } catch { /* 무시 */ }
    const why = res.status === 401 ? 'OpenRouter 키가 올바르지 않아요.'
      : res.status === 402 ? 'OpenRouter 크레딧이 부족해요.'
      : res.status === 429 ? 'OpenRouter 호출 한도에 걸렸어요. 잠시 뒤 다시 시도해 주세요.'
      : `OpenRouter 오류(HTTP ${res.status}).`;
    throw new UserError(502, 'OPENROUTER_HTTP_' + res.status, why + (msg ? ` (${cut(scrub(msg), 160)})` : ''));
  }
  let data: any;
  try { data = JSON.parse(body); } catch { throw new UserError(502, 'OPENROUTER_BAD_JSON', 'OpenRouter 응답을 읽지 못했어요.'); }
  return { model: String(data?.model || model), raw: String(data?.choices?.[0]?.message?.content ?? '') };
}

/** AI 답 검증: 실제 후보에 없는 ID·중복 ID·형식 오류를 거르고 최대 10건 */
export function validateRecommendations(raw: string, allowedIds: Set<string>) {
  let parsed: any = null;
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  try { parsed = JSON.parse(s >= 0 && e > s ? raw.slice(s, e + 1) : raw); } catch { /* 아래에서 처리 */ }
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    throw new UserError(502, 'AI_BAD_FORMAT', 'AI 답이 약속한 JSON 형식이 아니에요. 다시 검토해 주세요.');
  }
  const kept: { candidate_id: string; importance: number; reason: string }[] = [];
  const dropped: { candidate_id: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const r of parsed.recommendations) {
    const id = String(r?.candidate_id ?? '').trim();
    if (!allowedIds.has(id)) { dropped.push({ candidate_id: cut(id, 60), why: '실제 후보에 없는 ID' }); continue; }
    if (seen.has(id)) { dropped.push({ candidate_id: id, why: '중복 ID' }); continue; }
    const reason = String(r?.reason ?? '').replace(/\s+/g, ' ').trim();
    if (!reason) { dropped.push({ candidate_id: id, why: '선정 사유 없음' }); continue; }
    seen.add(id);
    const imp = Math.round(Number(r?.importance));
    kept.push({ candidate_id: id, importance: Number.isFinite(imp) ? Math.min(5, Math.max(1, imp)) : 3, reason: cut(reason, 150) });
  }
  kept.sort((a, b) => b.importance - a.importance);
  for (const x of kept.splice(MAX_ITEMS)) dropped.push({ candidate_id: x.candidate_id, why: '10건 초과' });
  return { kept, dropped };
}

// ---------------- 확정 연혁 읽기 ----------------
async function currentHistory(taskId: string) {
  const confs = await rest(`law_history_confirmations?select=id,version_no,confirmed_at,confirmed_by,model,item_count&task_id=eq.${encodeURIComponent(taskId)}&is_current=eq.true&limit=1`);
  if (!confs.length) return null;
  const c = confs[0];
  const items = await rest(`law_history_items?select=sort_order,candidate_id,candidate_key,law_id,law_name,effective_date,promulgation_date,promulgation_no,revision_type,changed_summary,importance,reason,source_url,previous_source_url&confirmation_id=eq.${c.id}&order=sort_order.asc`);
  return { ...c, items: items.map((i: any) => ({ ...i, is_future: isFutureNow(i) })) };
}

// ---------------- 후보 수집(3단계 함수 재사용) ----------------
async function runSync(taskId: string) {
  try {
    const res = await fetch(`${env('SUPABASE_URL')}/functions/v1/law-history-sync`, {
      method: 'POST', signal: AbortSignal.timeout(100000),
      headers: { ...serverHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, max_pairs: 12, include_future: true }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) return { ok: false, message: j?.error?.message || j?.errors?.[0]?.message || `law-history-sync HTTP ${res.status}` };
    return { ok: !!j.ok, saved: j.saved, versions_found: j.laws?.[0]?.versions_found, candidates: j.candidates?.length ?? 0, message: j.errors?.[0]?.message };
  } catch (e) {
    return { ok: false, message: (e as Error)?.name === 'TimeoutError' ? '후보 수집이 100초를 넘었어요.' : '후보 수집 함수(law-history-sync)에 연결하지 못했어요.' };
  }
}

// ---------------- 요청 처리 ----------------
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    let input: any = {};
    if (req.method === 'POST') { try { input = await req.json(); } catch { /* 빈 본문 */ } }
    else if (req.method === 'GET') { const q = new URL(req.url).searchParams; input = { action: q.get('action') ?? 'current', task_id: q.get('task_id') }; }
    else throw new UserError(405, 'METHOD', 'GET 또는 POST 로 호출해 주세요.');

    const action = String(input.action ?? 'current');
    const taskId = String(input.task_id ?? input.taskId ?? '').trim();
    if (!TASK_ID_RE.test(taskId)) throw new UserError(400, 'BAD_TASK_ID', '"task_id": "child-allowance" 형식으로 보내 주세요.');

    if (action === 'current') {
      if (!isPublicCaller(req) && !isServerCaller(req)) throw new UserError(401, 'BAD_APIKEY', '홈페이지 공개 키가 이 프로젝트 키와 달라요.');
      return json(200, { ok: true, task_id: taskId, today: todayKst(), history: await currentHistory(taskId) });
    }

    await requireTeam(req);

    if (action === 'sync') {
      const sync = await runSync(taskId);
      return json(sync.ok ? 200 : 502, { ok: sync.ok, task_id: taskId, sync });
    }

    if (action === 'review') {
      const requestedBy = cut(String(input.requested_by ?? '').trim(), 40) || null;
      const sync = input.skip_sync === true ? { ok: true, message: '수집 건너뜀' } : await runSync(taskId);
      const all: Candidate[] = await rest(`law_revision_candidates?select=${CAND_COLS}&task_id=eq.${encodeURIComponent(taskId)}&order=to_ef_yd.asc`);
      const cands = all.filter(isUseful);
      if (!cands.length) {
        throw new UserError(sync.ok ? 404 : 502, 'NO_CANDIDATES',
          '검토할 개정 후보가 없어요.' + (sync.ok ? '' : ` 후보 수집 실패: ${sync.message}`));
      }
      const allowed = new Set(cands.map((c) => c.id));
      let model = env('OPENROUTER_MODEL').trim() || 'openrouter/auto';
      try {
        const ai = await askOpenRouter(cands);
        model = ai.model;
        const { kept, dropped } = validateRecommendations(ai.raw, allowed);
        const saved = await rest('law_revision_reviews', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ task_id: taskId, status: 'succeeded', model, candidate_ids: [...allowed], recommendations: kept, dropped, requested_by: requestedBy }),
        });
        const byId = new Map(cands.map((c) => [c.id, c]));
        const recommendations = kept
          .map((k) => ({ ...factsOf(byId.get(k.candidate_id)!), importance: k.importance, reason: k.reason, evidence: evidence(byId.get(k.candidate_id)!) }))
          .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
        return json(200, { ok: true, task_id: taskId, review_id: saved[0].id, model, sync, considered: cands.length, recommendations, dropped });
      } catch (e) {
        const ue = e instanceof UserError ? e : new UserError(502, 'REVIEW_FAILED', '검토 중 문제가 생겼어요.');
        try {
          await rest('law_revision_reviews', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ task_id: taskId, status: 'failed', model, candidate_ids: [...allowed], requested_by: requestedBy, error: `${ue.code}: ${ue.message}` }),
          });
        } catch { /* 기록 실패는 무시 */ }
        return json(ue.status, { ok: false, task_id: taskId, sync, error: { code: ue.code, message: ue.message + ' 기존 확정 연혁은 그대로예요.' } });
      }
    }

    if (action === 'confirm') {
      const reviewId = String(input.review_id ?? '');
      const by = cut(String(input.confirmed_by ?? '').trim(), 40);
      if (!UUID_RE.test(reviewId)) throw new UserError(400, 'BAD_REVIEW_ID', 'review_id 가 필요해요. 먼저 「주요 개정 검토」를 실행해 주세요.');
      if (!by) throw new UserError(400, 'NO_CONFIRMER', '확정하는 팀원 이름(confirmed_by)을 적어 주세요.');
      const reviews = await rest(`law_revision_reviews?select=id,task_id,status,model,recommendations&id=eq.${reviewId}&limit=1`);
      const rv = reviews[0];
      if (!rv || rv.task_id !== taskId || rv.status !== 'succeeded') throw new UserError(404, 'REVIEW_NOT_FOUND', '이 업무의 성공한 검토 기록을 찾지 못했어요.');
      const recMap = new Map<string, any>((rv.recommendations ?? []).map((r: any) => [r.candidate_id, r]));
      const ids: string[] = [...new Set<string>((Array.isArray(input.candidate_ids) ? input.candidate_ids : []).map((x: unknown) => String(x)))].filter((id) => recMap.has(id));
      if (ids.length < 1) throw new UserError(400, 'NOTHING_SELECTED', '확정할 추천 항목을 1건 이상 선택해 주세요.');
      if (ids.length > MAX_ITEMS) throw new UserError(400, 'TOO_MANY', `최대 ${MAX_ITEMS}건까지 확정할 수 있어요.`);
      const cands: Candidate[] = await rest(`law_revision_candidates?select=${CAND_COLS}&task_id=eq.${encodeURIComponent(taskId)}&id=in.(${ids.join(',')})`);
      if (cands.length !== ids.length) throw new UserError(409, 'CANDIDATE_GONE', '선택한 후보 일부가 더 이상 없어요. 다시 검토해 주세요.');
      cands.sort((a, b) => a.to_ef_yd.localeCompare(b.to_ef_yd) || String(a.promulgation_date).localeCompare(String(b.promulgation_date)));
      const items = cands.map((c, i) => ({
        sort_order: i + 1, candidate_id: c.id, candidate_key: c.candidate_key, law_id: c.law_id, law_name: c.law_name,
        effective_date: c.to_ef_yd, promulgation_date: c.promulgation_date, promulgation_no: c.promulgation_no,
        revision_type: c.revision_type, changed_summary: changedSummary(c),
        importance: recMap.get(c.id).importance, reason: recMap.get(c.id).reason,
        source_url: c.source_url, previous_source_url: c.previous_source_url,
      }));
      await rest('rpc/confirm_law_history', {
        method: 'POST',
        body: JSON.stringify({ p_task_id: taskId, p_review_id: reviewId, p_model: rv.model, p_confirmed_by: by, p_items: items }),
      });
      return json(200, { ok: true, task_id: taskId, today: todayKst(), history: await currentHistory(taskId) });
    }

    throw new UserError(400, 'BAD_ACTION', 'action 은 current, sync, review, confirm 중 하나예요.');
  } catch (e) {
    if (e instanceof UserError) return json(e.status, { ok: false, error: { code: e.code, message: e.message } });
    console.error('law-history-review unexpected', (e as Error)?.name);
    return json(500, { ok: false, error: { code: 'UNKNOWN', message: '서버에서 예상하지 못한 문제가 생겼어요. 기존 확정 연혁은 그대로예요.' } });
  }
}

(globalThis as any).Deno?.serve(handle);
