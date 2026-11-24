// =====================================================================
// Supabase Edge Function: law-history-sync  (3단계 · 개정 후보 수집)
//
// POST { "task_id": "child-allowance" } 를 받으면
//   ① task_laws 에서 법령 ID·법령명을 읽고
//   ② 법제처 lawSearch.do (target=eflaw) 로 그 법령의 시행일별 버전 목록을 받고
//   ③ 연속된 두 버전을 lawService.do (target=eflaw, MST + efYd) 로 각각 조회해
//      추가·수정·삭제 조문과 관련 부칙을 비교한 뒤
//   ④ law_revision_candidates 에 저장합니다. 같은 후보는 다시 실행해도 한 줄만 유지돼요.
//
// 서버 설정(Edge Functions > Secrets): LAW_OC — 기존 법령 조회 함수가 쓰는 것과 같은 값
// 자동 제공: SUPABASE_URL, SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY
// 호출 권한: 서버용 키(service_role 또는 sb_secret_…) 또는 팀 코드(x-team-code 헤더)로 부를 때만 실행돼요.
//           팀 코드 = Secrets 의 TEAM_REVIEW_CODE, 또는 review_access_tokens 의 기한 있는 임시 코드
//           (DB에 저장하고 법제처를 여러 번 부르므로 공개 키로는 못 부르게 막음)
// 외부 라이브러리 없는 한 파일 → 대시보드 Via Editor 에 그대로 붙여 넣기 가능
// =====================================================================

const LAW_SEARCH = 'https://www.law.go.kr/DRF/lawSearch.do';
const LAW_SERVICE = 'https://www.law.go.kr/DRF/lawService.do';
const LAW_TIMEOUT_MS = 20000;
const MAX_PAIRS = 12;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-team-code',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------- 공통 도우미 ----------------
class UserError extends Error {
  constructor(public status: number, public code: string, message: string, public hint?: unknown) { super(message); }
}
const env = (n: string): string => (globalThis as any).Deno?.env?.get(n) ?? '';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const arr = <T = any>(v: unknown): T[] => (v === undefined || v === null || v === '' ? [] : (Array.isArray(v) ? v : [v]) as T[]);
function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(text).filter((s) => s.trim() !== '').join('\n');
  if (typeof v === 'object' && 'content' in (v as any)) return text((v as any).content);
  return '';
}
const clean = (s: string) => s.replace(/\r/g, '').split('\n').map((l) => l.replace(/^[\s　]+|[\s　]+$/g, '')).filter(Boolean).join('\n');
const digits8 = (v: unknown) => { const s = text(v).replace(/\D/g, ''); return s.length === 8 ? s : ''; };
const iso = (d8: string) => (d8 ? `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}` : null);
const todayKst8 = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const sourceUrl = (mst: string, ef: string) => `https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=${mst}&efYd=${ef}`;
const pick = (o: any, ...keys: string[]) => { for (const k of keys) { const t = text(o?.[k]).trim(); if (t) return t; } return ''; };

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------- 법제처 호출 (인증값은 응답·로그에 절대 싣지 않음) ----------------
async function callLaw(base: string, params: Record<string, string>, oc: string, what: string): Promise<any> {
  const url = new URL(base);
  url.searchParams.set('OC', oc);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(LAW_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch (e) {
    const t = (e as Error)?.name === 'TimeoutError';
    throw new UserError(504, t ? 'LAW_TIMEOUT' : 'LAW_UNREACHABLE', `${what}: 법제처 ${t ? '응답이 20초 안에 오지 않았어요' : '서버에 연결하지 못했어요'}.`);
  }
  const body = await res.text();
  if (!res.ok) throw new UserError(502, 'LAW_HTTP_' + res.status, `${what}: 법제처가 HTTP ${res.status} 오류를 돌려줬어요.`);
  try { return JSON.parse(body); }
  catch { throw new UserError(502, 'LAW_NOT_JSON', `${what}: 법제처가 JSON 대신 안내 페이지를 보냈어요. LAW_OC 값과 OPEN API 신청 항목(시행일 법령 목록·본문)을 확인해 주세요.`); }
}

// ---------------- ② 버전 목록 ----------------
type Version = { mst: string; efYd: string; promDate: string; promNo: string; revType: string; state: string; name: string };

async function listVersions(lawId: string, lawName: string, oc: string): Promise<Version[]> {
  const seen = new Map<string, Version>();
  let otherLawIds = new Set<string>();
  let sampleKeys: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const raw = await callLaw(LAW_SEARCH, {
      target: 'eflaw', type: 'JSON', query: lawName, nw: '1,2,3', display: '100', page: String(page),
    }, oc, '버전 목록 조회');
    const root = raw?.LawSearch ?? raw?.lawSearch ?? raw;
    const items = arr(root?.law ?? root?.Law);
    if (items[0]) sampleKeys = Object.keys(items[0]);
    for (const it of items) {
      const id = pick(it, '법령ID', 'lawId').padStart(6, '0');
      if (id !== lawId) { otherLawIds.add(id); continue; }
      const v: Version = {
        mst: pick(it, '법령일련번호', 'MST', 'lsiSeq'),
        efYd: digits8(pick(it, '시행일자', 'efYd')),
        promDate: digits8(pick(it, '공포일자', 'ancYd')),
        promNo: pick(it, '공포번호', 'ancNo'),
        revType: pick(it, '제개정구분명', '제개정구분'),
        state: pick(it, '현행연혁코드'),
        name: pick(it, '법령명한글', '법령명_한글'),
      };
      if (v.mst && v.efYd) seen.set(`${v.mst}@${v.efYd}`, v);
    }
    const total = Number(text(root?.totalCnt)) || 0;
    if (items.length === 0 || page * 100 >= total) break;
  }
  if (seen.size === 0) {
    throw new UserError(502, 'NO_VERSIONS', `법제처 버전 목록에서 법령 ID ${lawId}(${lawName})를 찾지 못했어요. task_laws 의 법령명·ID를 확인해 주세요.`,
      { other_law_ids_in_result: [...otherLawIds].slice(0, 5), item_fields_seen: sampleKeys });
  }
  // 시행일 → 같은 날이면 법령일련번호 순
  return [...seen.values()].sort((a, b) => a.efYd.localeCompare(b.efYd) || Number(a.mst) - Number(b.mst));
}

// ---------------- ③ 버전 본문 → 조문 맵 ----------------
type Article = { key: string; title: string; deleted: boolean; lines: string[]; text: string };
type Body = { articles: Map<string, Article>; order: string[]; addenda: { promNo: string; promDate: string; text: string }[]; promNo: string };

function lawLines(u: any): string[] {
  const lines: string[] = [];
  const head = clean(text(u['조문내용']));
  if (head) lines.push(...head.split('\n'));
  for (const h of arr(u['항'])) {
    const ht = clean(text(h['항내용'])); if (ht) lines.push(...ht.split('\n'));
    for (const ho of arr(h['호'])) {
      const t = clean(text(ho['호내용'])); if (t) lines.push(...t.split('\n'));
      for (const m of arr(ho['목'])) { const mt = clean(text(m['목내용'])); if (mt) lines.push(...mt.split('\n')); }
    }
  }
  return lines;
}

function parseBody(raw: any): Body | null {
  const root = raw?.['법령'];
  if (!root || typeof root !== 'object') return null;
  const articles = new Map<string, Article>();
  const order: string[] = [];
  for (const u of arr(root['조문']?.['조문단위'])) {
    if (text(u['조문여부']) === '전문') continue; // 장·절 제목
    const no = text(u['조문번호']).trim();
    if (!no) continue;
    const br = text(u['조문가지번호']).trim();
    const key = `제${no}조${br && br !== '0' ? '의' + br : ''}`;
    const lines = lawLines(u);
    const head = lines[0] ?? '';
    articles.set(key, {
      key,
      title: text(u['조문제목']).trim(),
      deleted: /^제\d+조(의\d+)?\s*삭제/.test(head),
      lines,
      text: lines.join('\n'),
    });
    order.push(key);
  }
  const addenda = arr(root['부칙']?.['부칙단위']).map((b: any) => ({
    promNo: pick(b, '부칙공포번호'),
    promDate: digits8(pick(b, '부칙공포일자')),
    text: clean(text(b['부칙내용'])),
  }));
  return { articles, order, addenda, promNo: pick(root['기본정보'] ?? {}, '공포번호') };
}

const bodyCache = new Map<string, Body>();
async function fetchBody(v: Version, oc: string): Promise<Body> {
  const k = `${v.mst}@${v.efYd}`;
  const hit = bodyCache.get(k);
  if (hit) return hit;
  const raw = await callLaw(LAW_SERVICE, { target: 'eflaw', type: 'JSON', MST: v.mst, efYd: v.efYd }, oc, `본문 조회(${k})`);
  const body = parseBody(raw);
  if (!body || body.articles.size === 0) throw new UserError(502, 'LAW_EMPTY_BODY', `본문 조회(${k}): 법제처 응답에 조문이 없어요.`);
  bodyCache.set(k, body);
  return body;
}

// ---------------- 비교 ----------------
/** 줄 단위 LCS 비교 → 빠진 줄 / 새로 생긴 줄 */
function lineDiff(a: string[], b: string[]) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { removed, added };
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const artNum = (k: string) => { const m = /제(\d+)조(?:의(\d+))?/.exec(k); return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : 0; };

function compare(prev: Body, next: Body) {
  const keys = [...new Set([...prev.order, ...next.order])].sort((x, y) => artNum(x) - artNum(y));
  const changes: any[] = [];
  for (const k of keys) {
    const a = prev.articles.get(k), b = next.articles.get(k);
    const aLive = a && !a.deleted, bLive = b && !b.deleted;
    let type: 'added' | 'modified' | 'deleted' | null = null;
    if (!aLive && bLive) type = 'added';
    else if (aLive && !bLive) type = 'deleted';
    else if (aLive && bLive && norm(a!.text) !== norm(b!.text)) type = 'modified';
    if (!type) continue;
    const d = lineDiff(a?.lines ?? [], b?.lines ?? []);
    changes.push({
      article: k,
      title: b?.title || a?.title || '',
      change_type: type,
      change_label: { added: '신설', modified: '개정', deleted: '삭제' }[type],
      before_text: a?.text ?? '',
      after_text: b?.text ?? '',
      removed_lines: d.removed,
      added_lines: d.added,
    });
  }
  return changes;
}

// ---------------- task_laws 읽기 / 후보 저장 (Supabase REST, 서버 키) ----------------
function dbHeaders(): Record<string, string> {
  let secret = '';
  try { secret = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default ?? ''; } catch { /* 무시 */ }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!env('SUPABASE_URL') || (!secret && !legacy)) throw new UserError(500, 'SERVER_CONFIG', '서버 설정(Supabase 키)이 비어 있어요.');
  return secret ? { apikey: secret } : { apikey: legacy, Authorization: `Bearer ${legacy}` };
}
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, { ...init, headers: { ...dbHeaders(), 'Content-Type': 'application/json', ...(init.headers as any) } });
  const t = await res.text();
  if (!res.ok) {
    const missing = res.status === 404 || /does not exist|Could not find the table/i.test(t);
    throw new UserError(500, 'DB_ERROR', missing ? '저장용 표가 없어요. 02_law_revision_candidates.sql 을 먼저 실행해 주세요.' : `DB 작업 실패(HTTP ${res.status}).`);
  }
  return t ? JSON.parse(t) : null;
}

/** 서버용 키로 부른 요청만 통과 */
function isServerCaller(req: Request): boolean {
  const sent = [req.headers.get('apikey') ?? '', (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')].filter(Boolean);
  const allowed: string[] = [];
  try { allowed.push(...Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}')).map(String)); } catch { /* 무시 */ }
  if (env('SUPABASE_SERVICE_ROLE_KEY')) allowed.push(env('SUPABASE_SERVICE_ROLE_KEY'));
  return allowed.length > 0 && sent.some((s) => allowed.includes(s));
}

/** 팀 코드 확인: Secrets 의 TEAM_REVIEW_CODE 와 같거나, 기한 안의 임시 코드(해시 저장)와 같으면 통과 */
function sameText(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function isTeamCaller(req: Request): Promise<boolean> {
  const code = (req.headers.get('x-team-code') ?? '').trim();
  if (code.length < 6) return false;
  if (sameText(code, env('TEAM_REVIEW_CODE').trim())) return true;
  try {
    const rows = await rest(`review_access_tokens?select=id&token_hash=eq.${await sha256(code)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; } // 표가 없으면 임시 코드 기능만 꺼짐
}

// ---------------- 요청 처리 ----------------
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'POST') throw new UserError(405, 'METHOD', 'POST 로 호출해 주세요.');
    if (!isServerCaller(req) && !(await isTeamCaller(req))) {
      await new Promise((r) => setTimeout(r, 800)); // 코드 무작위 대입 늦추기
      throw new UserError(401, 'NEED_SERVER_KEY', '서버용 키(service_role) 또는 팀 코드(x-team-code)가 필요해요. Test 창의 Authorization 을 service_role 로 바꾸거나 x-team-code 헤더를 넣어 주세요.');
    }
    let input: any = {};
    try { input = await req.json(); } catch { /* 빈 본문 */ }
    const taskId = String(input.task_id ?? input.taskId ?? '').trim();
    if (!TASK_ID_RE.test(taskId)) throw new UserError(400, 'BAD_TASK_ID', '입력값에 "task_id": "child-allowance" 형식으로 넣어 주세요.');
    const maxPairs = Math.min(MAX_PAIRS, Math.max(1, Number(input.max_pairs ?? 1) || 1));
    const includeFuture = input.include_future === true;
    const dryRun = input.dry_run === true;

    const oc = env('LAW_OC').trim();
    if (!oc) throw new UserError(500, 'NO_OC', '서버에 법제처 인증값(LAW_OC)이 없어요. Edge Functions > Secrets 를 확인해 주세요.');

    const links: { law_id: string; law_name: string }[] =
      await rest(`task_laws?select=law_id,law_name&task_id=eq.${encodeURIComponent(taskId)}&order=law_id`);
    if (!links.length) throw new UserError(404, 'NO_LINK', `「${taskId}」 업무에 연결된 법령이 task_laws 에 없어요.`);

    const today = todayKst8();
    const results: any[] = [];
    const lawsOut: any[] = [];
    const errors: any[] = [];

    for (const link of links) {
      const lawId = String(link.law_id).padStart(6, '0');
      try {
        const all = await listVersions(lawId, link.law_name, oc);
        const usable = includeFuture ? all : all.filter((v) => v.efYd <= today);
        lawsOut.push({
          law_id: lawId, law_name: link.law_name, versions_found: all.length,
          versions: all.map((v) => ({ mst: v.mst, ef_yd: iso(v.efYd), promulgation_date: iso(v.promDate), promulgation_no: v.promNo, revision_type: v.revType, state: v.state || (v.efYd > today ? '시행예정' : '') })),
        });
        // 최신 버전부터 거꾸로 max_pairs 개의 (이전 → 다음) 쌍
        for (let i = usable.length - 1, n = 0; i >= 1 && n < maxPairs; i--, n++) {
          const from = usable[i - 1], to = usable[i];
          const [pb, nb] = [await fetchBody(from, oc), await fetchBody(to, oc)];
          const changed = compare(pb, nb);
          const promNo = to.promNo || nb.promNo;
          const addenda = nb.addenda
            .filter((a) => (promNo && a.promNo === promNo) || (!promNo && a.promDate === to.promDate))
            .map((a) => ({ title: `부칙 <제${a.promNo}호, ${iso(a.promDate) ?? ''}>`, promulgation_no: a.promNo, promulgation_date: iso(a.promDate), text: a.text }));
          const key = `${lawId}:${from.mst}@${from.efYd}>${to.mst}@${to.efYd}`;
          const row = {
            task_id: taskId, law_id: lawId, law_name: link.law_name, candidate_key: key,
            from_mst: from.mst, from_ef_yd: iso(from.efYd), to_mst: to.mst, to_ef_yd: iso(to.efYd),
            promulgation_date: iso(to.promDate), promulgation_no: promNo, revision_type: to.revType,
            is_future: to.efYd > today,
            source_url: sourceUrl(to.mst, to.efYd), previous_source_url: sourceUrl(from.mst, from.efYd),
            added_count: changed.filter((c) => c.change_type === 'added').length,
            modified_count: changed.filter((c) => c.change_type === 'modified').length,
            deleted_count: changed.filter((c) => c.change_type === 'deleted').length,
            changed_articles: changed,
            supplementary_provisions: addenda,
          };
          const content_hash = await sha256(JSON.stringify([row.changed_articles, row.supplementary_provisions, row.promulgation_no, row.revision_type]));
          results.push({ ...row, content_hash });
        }
      } catch (e) {
        const ue = e instanceof UserError ? e : new UserError(502, 'SYNC_FAILED', '버전 비교 중 문제가 생겼어요.');
        errors.push({ law_id: lawId, law_name: link.law_name, code: ue.code, message: ue.message, hint: ue.hint });
      }
    }

    // ④ 저장: 이미 있던 후보인지 먼저 확인 → upsert (task_id + candidate_key 가 같으면 덮어쓰기)
    const saved = { inserted: 0, updated: 0, unchanged: 0 };
    if (results.length && !dryRun) {
      const keys = results.map((r) => `"${r.candidate_key}"`).join(',');
      const before: { candidate_key: string; content_hash: string }[] =
        await rest(`law_revision_candidates?select=candidate_key,content_hash&task_id=eq.${encodeURIComponent(taskId)}&candidate_key=in.(${encodeURIComponent(keys)})`);
      const prevHash = new Map(before.map((b) => [b.candidate_key, b.content_hash]));
      const now = new Date().toISOString();
      for (const r of results) {
        r.save_result = !prevHash.has(r.candidate_key) ? 'inserted' : prevHash.get(r.candidate_key) === r.content_hash ? 'unchanged' : 'updated';
        // 내용이 같으면 last_synced_at 만 갱신, 달라졌으면 updated_at 도 갱신. first_seen_at·id·status 는 보내지 않아 그대로 유지
        const payload = { ...r, last_synced_at: now, ...(r.save_result === 'unchanged' ? {} : { updated_at: now }) };
        delete (payload as any).save_result;
        await rest('law_revision_candidates?on_conflict=task_id,candidate_key', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(payload),
        });
        saved[r.save_result as keyof typeof saved]++;
      }
    } else for (const r of results) r.save_result = dryRun ? 'dry_run' : 'none';

    const body = {
      ok: errors.length === 0,
      message: results.length ? undefined : '비교할 이전 버전이 없어요(버전이 1개뿐이거나 모두 시행예정).',
      task_id: taskId,
      options: { max_pairs: maxPairs, include_future: includeFuture, dry_run: dryRun },
      laws: lawsOut,
      saved,
      candidates: results.map(({ content_hash, ...r }) => r),
      errors,
    };
    return json(errors.length && !results.length ? 502 : 200, body);
  } catch (e) {
    if (e instanceof UserError) return json(e.status, { ok: false, error: { code: e.code, message: e.message, hint: e.hint } });
    console.error('law-history-sync unexpected', (e as Error)?.name);
    return json(500, { ok: false, error: { code: 'UNKNOWN', message: '서버에서 예상하지 못한 문제가 생겼어요.' } });
  }
}

(globalThis as any).Deno?.serve(handle);
