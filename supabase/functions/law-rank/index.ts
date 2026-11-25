// =====================================================================
// Supabase Edge Function: law-rank  (OpenRouter 주요 개정 추천 · 단독 테스트용)
//
// POST 로 개정 후보 목록을 받아 OpenRouter 에 "주요 개정 최대 10건"을 묻고,
// 검증한 추천(후보 ID · 중요도 · 한 줄 선정 사유)만 돌려줍니다.
//   - 확정 연혁·후보 표를 바꾸지 않습니다(읽기만 함).
//   - 시행일·공포일·원문 링크는 AI 가 아니라 law_revision_candidates(법제처 값)에서 붙입니다.
//   - 호출 권한: 서버용 키(service_role / sb_secret_…) 또는 팀 코드(x-team-code)
//
// Secrets: OPENROUTER_API_KEY (필수), OPENROUTER_RANK_MODEL (선택, 비우면 openrouter/free),
//          TEAM_REVIEW_CODE (선택, 팀 코드로 부를 때)
// 키는 코드·로그·응답에 절대 싣지 않습니다.
// =====================================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/free';
const MAX_ITEMS = 10;
const MAX_CANDIDATES = 40;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-team-code',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class UserError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const env = (n: string): string => (globalThis as any).Deno?.env?.get(n) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

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

// ---------------- Supabase REST (읽기 전용, 서버 키) ----------------
function serverHeaders(): Record<string, string> {
  let secret = '';
  try { secret = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default ?? ''; } catch { /* 무시 */ }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!env('SUPABASE_URL') || (!secret && !legacy)) throw new UserError(500, 'SERVER_CONFIG', '서버 설정(Supabase 키)이 비어 있어요.');
  return secret ? { apikey: secret } : { apikey: legacy, Authorization: `Bearer ${legacy}` };
}
async function restGet(path: string) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, { headers: serverHeaders() });
  const t = await res.text();
  if (!res.ok) {
    const missing = res.status === 404 || /does not exist|Could not find/i.test(t);
    throw new UserError(500, 'DB_ERROR', missing ? 'law_revision_candidates 표가 없어요. 3단계 SQL을 먼저 실행해 주세요.' : `후보 표를 읽지 못했어요(HTTP ${res.status}).`);
  }
  return t ? JSON.parse(t) : [];
}

// ---------------- 호출 권한: 서버 키 또는 팀 코드 ----------------
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
    const rows = await restGet(`review_access_tokens?select=id&token_hash=eq.${await sha256(code)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

// ---------------- 입력 후보 정리 ----------------
type Article = { article: string; title?: string; change_label?: string; before_text?: string; after_text?: string };
type Cand = { candidate_id: string; changed_articles: Article[]; supplementary_provisions: { title?: string; text?: string }[]; db?: any };
const DB_COLS = 'id,task_id,law_id,law_name,candidate_key,to_ef_yd,promulgation_date,promulgation_no,revision_type,source_url,previous_source_url,changed_articles,supplementary_provisions';

function normArticles(v: unknown): Article[] {
  return (Array.isArray(v) ? v : []).slice(0, 8).map((a: any) => ({
    article: cut(a?.article ?? a?.조문 ?? '', 40),
    title: cut(a?.title ?? a?.제목 ?? '', 80),
    change_label: cut(a?.change_label ?? a?.구분 ?? '', 10),
    before_text: cut(a?.before_text ?? a?.개정전 ?? '', 600),
    after_text: cut(a?.after_text ?? a?.개정후 ?? '', 600),
  })).filter((a) => a.article || a.before_text || a.after_text);
}

/** 시행일·공포일·원문 링크: 기존 후보 데이터(법제처 값)에서만 */
function factsOf(db: any) {
  if (!db) return null;
  return {
    candidate_key: db.candidate_key, law_name: db.law_name,
    effective_date: db.to_ef_yd, promulgation_date: db.promulgation_date, promulgation_no: db.promulgation_no,
    revision_type: db.revision_type, is_future: String(db.to_ef_yd ?? '') > todayKst(),
    source_url: db.source_url, previous_source_url: db.previous_source_url,
  };
}

// ---------------- OpenRouter ----------------
const SYSTEM_PROMPT = [
  '당신은 보건복지부 아동수당 업무 인수인계를 돕는 법령 개정 분석가입니다.',
  '입력은 아동수당법 개정 후보 목록입니다. 각 후보에는 후보 ID, 바뀐 조문, 개정 전·후 문구(있으면 관련 부칙)가 있습니다.',
  '아동수당의 ① 지원 대상(연령·자격) ② 지급액 ③ 신청 및 지급 절차 에 영향이 큰 개정을 우선 고르세요. 경과조치·특례(부칙)도 이 세 가지에 영향을 주면 반영하세요.',
  '용어 정비·기관 명칭 변경·인용 조문 정리만 있는 후보는 고르지 마세요.',
  '규칙: candidate_id 는 입력값을 그대로 쓰기 · 같은 ID 한 번만 · 최대 10건이고 중요한 것이 적으면 적게(억지로 채우지 않기)',
  '· importance 는 5(매우 큼)~1(작음) 정수 · reason 은 근거 조문을 들어 한국어 한 문장(80자 이내) · 입력에 없는 사실·숫자·날짜를 만들지 않기.',
  '출력은 JSON 하나만, 다른 글 없이: {"recommendations":[{"candidate_id":"…","importance":5,"reason":"…"}]}',
].join('\n');

async function askOpenRouter(cands: Cand[], model: string) {
  const key = env('OPENROUTER_API_KEY').trim();
  if (!key) throw new UserError(500, 'NO_OPENROUTER_KEY', '서버에 OPENROUTER_API_KEY 가 없어요. Edge Functions > Secrets 를 확인해 주세요.');
  const scrub = (s: string) => s.split(key).join('***');
  const input = cands.map((c) => ({
    candidate_id: c.candidate_id,
    바뀐조문: c.changed_articles.map((a) => ({ 조문: a.article, 제목: a.title, 구분: a.change_label, 개정전: a.before_text, 개정후: a.after_text })),
    관련부칙: c.supplementary_provisions.slice(0, 2).map((s) => cut(`${s.title ?? ''}\n${s.text ?? ''}`, 800)),
  }));
  let res: Response;
  const started = Date.now();
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'MOHW law-rank test' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ 후보: input }) },
        ],
      }),
    });
  } catch (e) {
    throw new UserError(504, 'OPENROUTER_UNREACHABLE', (e as Error)?.name === 'TimeoutError'
      ? 'OpenRouter 응답이 90초 안에 오지 않았어요(무료 모델은 느릴 수 있어요).' : 'OpenRouter 에 연결하지 못했어요.');
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.parse(body)?.error?.message ?? ''; } catch { /* 무시 */ }
    const why = res.status === 401 ? 'OpenRouter 키가 올바르지 않아요.'
      : res.status === 402 ? 'OpenRouter 크레딧이 부족해요.'
      : res.status === 429 ? 'OpenRouter 호출 한도에 걸렸어요(무료 모델은 한도가 낮아요). 잠시 뒤 다시 시도해 주세요.'
      : `OpenRouter 오류(HTTP ${res.status}).`;
    throw new UserError(502, 'OPENROUTER_HTTP_' + res.status, why + (msg ? ` (${cut(scrub(msg), 200)})` : ''));
  }
  let data: any;
  try { data = JSON.parse(body); } catch { throw new UserError(502, 'OPENROUTER_BAD_JSON', 'OpenRouter 응답을 읽지 못했어요.'); }
  return {
    model_used: String(data?.model || model),
    content: String(data?.choices?.[0]?.message?.content ?? ''),
    usage: data?.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens } : null,
    elapsed_ms: Date.now() - started,
  };
}

/** 검증: 입력 목록에 없는 ID · 중복 ID · 사유 없음 · 10건 초과를 걸러냄 */
export function validate(content: string, allowed: Set<string>) {
  let parsed: any = null;
  const s = content.indexOf('{'), e = content.lastIndexOf('}');
  try { parsed = JSON.parse(s >= 0 && e > s ? content.slice(s, e + 1) : content); } catch { /* 아래 처리 */ }
  if (!parsed || !Array.isArray(parsed.recommendations)) {
    throw new UserError(502, 'AI_BAD_FORMAT', `AI 답이 약속한 JSON 형식이 아니에요. 다시 시도하거나 다른 모델을 써 보세요. (답 앞부분: ${cut(content.replace(/\s+/g, ' '), 120)})`);
  }
  const kept: { candidate_id: string; importance: number; reason: string }[] = [];
  const dropped: { candidate_id: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const r of parsed.recommendations) {
    const id = String(r?.candidate_id ?? '').trim();
    if (!allowed.has(id)) { dropped.push({ candidate_id: cut(id, 60), why: '입력 목록에 없는 ID' }); continue; }
    if (seen.has(id)) { dropped.push({ candidate_id: id, why: '중복 ID' }); continue; }
    const reason = String(r?.reason ?? '').replace(/\s+/g, ' ').trim();
    if (!reason) { dropped.push({ candidate_id: id, why: '선정 사유 없음' }); continue; }
    seen.add(id);
    const imp = Math.round(Number(r?.importance));
    kept.push({ candidate_id: id, importance: Number.isFinite(imp) ? Math.min(5, Math.max(1, imp)) : 3, reason: cut(reason, 150) });
  }
  kept.sort((a, b) => b.importance - a.importance);
  for (const x of kept.splice(MAX_ITEMS)) dropped.push({ candidate_id: x.candidate_id, why: '최대 10건 초과' });
  return { kept, dropped, raw_count: parsed.recommendations.length };
}

// ---------------- 요청 처리 ----------------
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') throw new UserError(405, 'METHOD', 'POST 로 호출해 주세요.');
    if (!isServerCaller(req) && !(await isTeamCaller(req))) {
      await new Promise((r) => setTimeout(r, 800));
      throw new UserError(401, 'NEED_TEAM_OR_SERVER', '팀 코드(x-team-code) 또는 서버용 키(service_role)가 필요해요. Test 창 Authorization 을 service_role 로 바꿔 주세요.');
    }
    let input: any = {};
    try { input = await req.json(); } catch { throw new UserError(400, 'BAD_JSON', '요청 본문이 JSON 이 아니에요.'); }
    const taskId = String(input.task_id ?? 'child-allowance').trim();
    if (!TASK_ID_RE.test(taskId)) throw new UserError(400, 'BAD_TASK_ID', 'task_id 형식이 올바르지 않아요.');

    // 1) 후보: 요청에 candidates 가 있으면 그것을, 없으면 law_revision_candidates 에서
    let cands: Cand[] = [];
    if (Array.isArray(input.candidates) && input.candidates.length) {
      const seenIn = new Set<string>();
      for (const c of input.candidates.slice(0, MAX_CANDIDATES)) {
        const id = String(c?.candidate_id ?? c?.id ?? '').trim();
        if (!id || seenIn.has(id)) continue;
        seenIn.add(id);
        cands.push({ candidate_id: id, changed_articles: normArticles(c?.changed_articles ?? c?.바뀐조문), supplementary_provisions: Array.isArray(c?.supplementary_provisions) ? c.supplementary_provisions : [] });
      }
      if (!cands.length) throw new UserError(400, 'NO_CANDIDATES', 'candidates 에 candidate_id 가 있는 항목이 없어요.');
      // 기존 후보 데이터와 맞춰 보기(UUID 는 id, 그 밖은 candidate_key)
      const uuids = cands.map((c) => c.candidate_id).filter((id) => UUID_RE.test(id));
      const keys = cands.map((c) => c.candidate_id).filter((id) => !UUID_RE.test(id));
      const rows: any[] = [];
      if (uuids.length) rows.push(...await restGet(`law_revision_candidates?select=${DB_COLS}&task_id=eq.${encodeURIComponent(taskId)}&id=in.(${uuids.join(',')})`));
      if (keys.length) rows.push(...await restGet(`law_revision_candidates?select=${DB_COLS}&task_id=eq.${encodeURIComponent(taskId)}&candidate_key=in.(${encodeURIComponent(keys.map((k) => `"${k}"`).join(','))})`));
      for (const c of cands) {
        c.db = rows.find((r) => r.id === c.candidate_id || r.candidate_key === c.candidate_id);
        if (!c.changed_articles.length && c.db) c.changed_articles = normArticles(c.db.changed_articles);
        if (!c.supplementary_provisions.length && c.db) c.supplementary_provisions = c.db.supplementary_provisions ?? [];
      }
    } else {
      const rows: any[] = await restGet(`law_revision_candidates?select=${DB_COLS}&task_id=eq.${encodeURIComponent(taskId)}&order=to_ef_yd.asc&limit=${MAX_CANDIDATES}`);
      cands = rows
        .filter((r) => (r.changed_articles?.length ?? 0) > 0 || (r.supplementary_provisions?.length ?? 0) > 0)
        .map((r) => ({ candidate_id: r.id, changed_articles: normArticles(r.changed_articles), supplementary_provisions: r.supplementary_provisions ?? [], db: r }));
      if (!cands.length) throw new UserError(404, 'NO_CANDIDATES', '저장된 개정 후보가 없어요. law-history-sync 를 먼저 실행하거나 요청에 candidates 를 넣어 주세요.');
    }
    const allowed = new Set(cands.map((c) => c.candidate_id));
    const model = String(input.model ?? '').trim() || env('OPENROUTER_RANK_MODEL').trim() || DEFAULT_MODEL;

    // 2) AI 호출 — test_ai_content 가 있으면 OpenRouter 대신 그 문자열로 검증만 시험(팀·서버 권한일 때만 여기까지 옴)
    const ai = typeof input.test_ai_content === 'string'
      ? { model_used: 'test_ai_content(실제 호출 안 함)', content: input.test_ai_content, usage: null, elapsed_ms: 0 }
      : await askOpenRouter(cands, model);

    // 3) 검증 + 법제처 값 붙이기
    const { kept, dropped, raw_count } = validate(ai.content, allowed);
    const byId = new Map(cands.map((c) => [c.candidate_id, c]));
    const recommendations = kept.map((k) => {
      const c = byId.get(k.candidate_id)!;
      return { candidate_id: k.candidate_id, importance: k.importance, reason: k.reason, changed_articles: c.changed_articles.map((a) => `${a.article} ${a.change_label ?? ''}`.trim()), facts: factsOf(c.db) };
    });
    const noFacts = recommendations.filter((r) => !r.facts).length;
    return json(200, {
      ok: true,
      task_id: taskId,
      model_requested: model,
      model_used: ai.model_used,
      elapsed_ms: ai.elapsed_ms,
      usage: ai.usage,
      input_count: cands.length,
      ai_returned: raw_count,
      recommendations,
      dropped,
      notes: [
        '확정 연혁과 후보 표는 바꾸지 않았어요(추천만 반환).',
        '시행일·공포일·원문 링크(facts)는 law_revision_candidates 의 법제처 값이에요.',
        ...(noFacts ? [`${noFacts}건은 기존 후보 데이터에서 찾지 못해 facts 가 비어 있어요. law-history-sync 로 후보를 먼저 저장하면 채워져요.`] : []),
      ],
    });
  } catch (e) {
    if (e instanceof UserError) return json(e.status, { ok: false, error: { code: e.code, message: e.message } });
    console.error('law-rank unexpected', (e as Error)?.name); // 내용은 남기지 않음(키 노출 방지)
    return json(500, { ok: false, error: { code: 'UNKNOWN', message: '서버에서 예상하지 못한 문제가 생겼어요.' } });
  }
}

(globalThis as any).Deno?.serve(handle);
