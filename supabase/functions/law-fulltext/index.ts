// =====================================================================
// Supabase Edge Function: law-fulltext
// 홈페이지가 업무 ID를 보내면
//   ① task_laws 에서 연결된 법령 ID를 읽고
//   ② 법제처 lawService.do (target=eflaw, type=JSON, JO 없음) 로 현행 전체 조문을 받아
//   ③ 조·항·호·목 구조를 살린 JSON 으로 돌려줍니다.
// { "taskId": "child-allowance", "refresh": true } 로 부르면 서버 보관본(10분)을 건너뛰고 다시 받습니다(법령 새로고침).
//
// 필요한 서버 설정(Edge Functions > Secrets):
//   LAW_OC  = 법제처 OPEN API 인증값(OC). 코드·HTML·GitHub 에는 절대 적지 않습니다.
// 자동으로 들어있는 값(따로 등록할 필요 없음):
//   SUPABASE_URL, SUPABASE_SECRET_KEYS 또는 SUPABASE_SERVICE_ROLE_KEY,
//   SUPABASE_PUBLISHABLE_KEYS 또는 SUPABASE_ANON_KEY
//
// 외부 라이브러리를 쓰지 않는 한 파일짜리 코드라 대시보드 편집기에 그대로 붙여 넣을 수 있습니다.
// =====================================================================

const LAW_API = 'https://www.law.go.kr/DRF/lawService.do';
const LAW_TIMEOUT_MS = 20000;
const CACHE_MS = 10 * 60 * 1000; // 같은 법령은 10분 동안 다시 부르지 않음(법제처 호출량 절약)
const REFRESH_MIN_MS = 60 * 1000; // 「법령 새로고침」을 눌러도 1분 안에는 방금 받은 본문을 그대로 씀(법제처 호출 절약)
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ---------- 응답 모양 ----------
type Mok = { number: string; text: string };
type Ho = { number: string; text: string; moks: Mok[] };
type Hang = { number: string; text: string; hos: Ho[] };
type Unit =
  | { kind: 'heading'; key: string; text: string }
  | {
      kind: 'article';
      key: string;
      label: string; // 제10조의2
      number: string; // 10
      branch: string; // 2 (없으면 '')
      title: string;
      text: string; // 조문 첫 줄(항이 없으면 본문 전체)
      deleted: boolean;
      effectiveDate: string; // YYYY-MM-DD 또는 ''
      paragraphs: Hang[];
    };

class UserError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ---------- 작은 도우미 ----------
function env(name: string): string {
  return (globalThis as any).Deno?.env?.get(name) ?? '';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** 하나일 때는 객체, 여럿일 때는 배열로 오는 법제처 JSON 을 항상 배열로 */
function arr<T = any>(v: unknown): T[] {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

/** 문자열·문자열 배열·중첩 배열·{content} 를 모두 여러 줄 문자열로 */
function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(text).filter((s) => s.trim() !== '').join('\n');
  if (typeof v === 'object' && 'content' in (v as any)) return text((v as any).content);
  return '';
}

/** 줄마다 앞뒤 공백·탭 정리 (법제처 원문은 들여쓰기용 탭이 섞여 옴) */
function clean(s: string): string {
  return s
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^[\s　]+|[\s　]+$/g, ''))
    .filter((line) => line !== '')
    .join('\n');
}

function ymd(v: unknown): string {
  const s = text(v).replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
}

function todayKst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- 법제처 JSON → 조·항·호·목 ----------
export function parseLaw(raw: any) {
  const root = raw?.['법령'];
  if (!root || typeof root !== 'object') return null;
  const info = root['기본정보'] ?? {};
  const units: Unit[] = [];

  arr(root['조문']?.['조문단위']).forEach((u: any, i: number) => {
    const key = text(u['조문키']) || String(i);
    const head = clean(text(u['조문내용']));
    if (text(u['조문여부']) === '전문') {
      // 장·절·관 제목 줄 (예: 제1장 총칙)
      if (head) units.push({ kind: 'heading', key, text: head });
      return;
    }
    const number = text(u['조문번호']).trim();
    const branch = text(u['조문가지번호']).trim();
    const label = `제${number}조${branch && branch !== '0' ? '의' + branch : ''}`;
    const paragraphs: Hang[] = arr(u['항']).map((h: any) => ({
      number: text(h['항번호']).trim(),
      text: clean(text(h['항내용'])),
      hos: arr(h['호']).map((ho: any) => ({
        number: text(ho['호번호']).trim(),
        text: clean(text(ho['호내용'])),
        moks: arr(ho['목']).map((m: any) => ({
          number: text(m['목번호']).trim(),
          text: clean(text(m['목내용'])),
        })),
      })),
    }));
    units.push({
      kind: 'article',
      key,
      label,
      number,
      branch: branch === '0' ? '' : branch,
      title: text(u['조문제목']).trim(),
      text: head,
      deleted: /^제\d+조(의\d+)?\s*삭제/.test(head),
      effectiveDate: ymd(u['조문시행일자']),
      paragraphs,
    });
  });

  const lawName = text(info['법령명_한글']).trim() || text(info['법령명한글']).trim();
  return {
    lawNameOfficial: lawName,
    lawKind: text(info['법종구분']).trim(),
    effectiveDate: ymd(info['시행일자']),
    promulgationDate: ymd(info['공포일자']),
    promulgationNo: text(info['공포번호']).trim(),
    revisionType: text(info['제개정구분']).trim(),
    ministry: text(info['소관부처']).trim(),
    articles: units,
    articleCount: units.filter((u) => u.kind === 'article').length,
  };
}

// ---------- 법제처 호출 ----------
const cache = new Map<string, { at: number; fetchedAt: string; parsed: ReturnType<typeof parseLaw> }>();

async function fetchLaw(lawId: string, oc: string, refresh = false) {
  const hit = cache.get(lawId);
  const keep = refresh ? REFRESH_MIN_MS : CACHE_MS; // 새로고침이면 보관본을 거의 무시
  if (hit && Date.now() - hit.at < keep) return { ...hit, cached: true };

  const url = new URL(LAW_API);
  url.searchParams.set('OC', oc);
  url.searchParams.set('target', 'eflaw');
  url.searchParams.set('ID', lawId);
  url.searchParams.set('type', 'JSON');
  // JO 는 보내지 않음 → 전체 조문

  // 오류 문구에 인증값이 섞여 나가지 않게 지우는 함수
  const scrub = (s: string) => (oc ? s.split(oc).join('***') : s).slice(0, 200);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(LAW_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch (e) {
    const timedOut = (e as Error)?.name === 'TimeoutError';
    throw new UserError(504, timedOut ? 'LAW_TIMEOUT' : 'LAW_UNREACHABLE',
      timedOut ? '법제처 응답이 20초 안에 오지 않았어요. 잠시 뒤 다시 시도해 주세요.'
               : '법제처 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  }
  const body = await res.text();
  if (!res.ok) {
    throw new UserError(502, 'LAW_HTTP_' + res.status, `법제처가 오류(HTTP ${res.status})를 돌려줬어요. 잠시 뒤 다시 시도해 주세요.`);
  }
  let raw: any;
  try {
    raw = JSON.parse(body);
  } catch {
    // 인증값 오류·미신청 API 는 JSON 대신 HTML 안내문이 오는 경우가 많음
    throw new UserError(502, 'LAW_NOT_JSON',
      '법제처가 법령 대신 안내 페이지를 보냈어요. 서버의 LAW_OC 인증값과 OPEN API 사용 신청(법령 본문) 상태를 확인해 주세요.');
  }
  const parsed = parseLaw(raw);
  if (!parsed || parsed.articles.length === 0) {
    const upstream = scrub(text(raw?.result ?? raw?.msg ?? raw?.message ?? ''));
    throw new UserError(502, 'LAW_EMPTY',
      '법제처 응답에 조문이 없어요.' + (upstream ? ` (법제처 안내: ${upstream})` : '') +
      ' 법령 ID와 LAW_OC 인증값을 확인해 주세요.');
  }
  const entry = { at: Date.now(), fetchedAt: new Date().toISOString(), parsed };
  cache.set(lawId, entry);
  return { ...entry, cached: false };
}

// ---------- task_laws 읽기 (Supabase REST, 서버 전용 키 사용) ----------
async function readTaskLaws(taskId: string): Promise<{ law_id: string; law_name: string }[]> {
  const base = env('SUPABASE_URL');
  let secret = '';
  try { secret = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default ?? ''; } catch { /* 무시 */ }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || (!secret && !legacy)) {
    throw new UserError(500, 'SERVER_CONFIG', '서버 설정(Supabase 키)이 비어 있어요. 관리자에게 알려 주세요.');
  }
  const headers: Record<string, string> = secret
    ? { apikey: secret }
    : { apikey: legacy, Authorization: `Bearer ${legacy}` };
  const url = `${base}/rest/v1/task_laws?select=law_id,law_name&task_id=eq.${encodeURIComponent(taskId)}&order=law_id`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new UserError(500, 'DB_ERROR',
      res.status === 404 ? 'task_laws 테이블을 찾지 못했어요. 등록용 SQL을 먼저 실행해 주세요.'
                         : `업무-법령 연결표를 읽지 못했어요(HTTP ${res.status}).`);
  }
  return await res.json();
}

/** 홈페이지가 보낸 apikey 가 이 프로젝트의 공개 키인지 확인 (아무나 법제처 호출량을 쓰지 못하게) */
function allowedCaller(req: Request): boolean {
  const sent = req.headers.get('apikey') ?? '';
  const keys: string[] = [];
  try { keys.push(...Object.values(JSON.parse(env('SUPABASE_PUBLISHABLE_KEYS') || '{}')).map(String)); } catch { /* 무시 */ }
  if (env('SUPABASE_ANON_KEY')) keys.push(env('SUPABASE_ANON_KEY'));
  if (keys.length === 0) return true; // 키 목록을 못 읽는 환경이면 막지 않음
  return keys.includes(sent);
}

// ---------- 요청 처리 ----------
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      throw new UserError(405, 'METHOD', 'GET 또는 POST 로 호출해 주세요.');
    }
    if (!allowedCaller(req)) {
      throw new UserError(401, 'BAD_APIKEY', '홈페이지 설정의 공개 키(publishable key)가 이 프로젝트 키와 달라요.');
    }

    const qs = new URL(req.url).searchParams;
    let taskId = qs.get('taskId') ?? '';
    let refresh = qs.get('refresh') === '1';
    if (req.method === 'POST') {
      try {
        const b = await req.json();
        taskId = String(b?.taskId ?? taskId);
        refresh = b?.refresh === true || refresh;
      } catch { /* 본문 없음 */ }
    }
    taskId = taskId.trim();
    if (!TASK_ID_RE.test(taskId)) {
      throw new UserError(400, 'BAD_TASK_ID', '업무 ID 형식이 올바르지 않아요. (예: child-allowance)');
    }

    const oc = env('LAW_OC').trim();
    if (!oc) {
      throw new UserError(500, 'NO_OC', '서버에 법제처 인증값(LAW_OC)이 등록되지 않았어요. Edge Functions > Secrets 에서 등록해 주세요.');
    }

    const links = await readTaskLaws(taskId);
    if (links.length === 0) {
      throw new UserError(404, 'NO_LINK', `「${taskId}」 업무에 연결된 법령이 없어요. 등록용 SQL을 실행했는지 확인해 주세요.`);
    }

    const today = todayKst();
    const laws: unknown[] = [];
    const errors: unknown[] = [];
    for (const link of links) {
      const lawId = String(link.law_id).padStart(6, '0');
      try {
        const { parsed, fetchedAt, cached } = await fetchLaw(lawId, oc, refresh);
        const name = parsed!.lawNameOfficial || link.law_name;
        laws.push({
          lawId,
          lawName: link.law_name,
          ...parsed,
          isFuture: !!parsed!.effectiveDate && parsed!.effectiveDate > today,
          sourceUrl: `https://www.law.go.kr/법령/${encodeURIComponent(name)}`,
          fetchedAt,
          cached,
        });
      } catch (e) {
        const ue = e instanceof UserError ? e : new UserError(502, 'LAW_PARSE', '법제처 응답을 읽는 중 문제가 생겼어요.');
        errors.push({ lawId, lawName: link.law_name, code: ue.code, message: ue.message });
      }
    }

    if (laws.length === 0) {
      const first = errors[0] as { code: string; message: string };
      return json(502, { ok: false, taskId, error: { code: first.code, message: first.message }, errors });
    }
    return json(200, { ok: true, taskId, refresh, requestedAt: new Date().toISOString(), laws, errors });
  } catch (e) {
    if (e instanceof UserError) return json(e.status, { ok: false, error: { code: e.code, message: e.message } });
    console.error('law-fulltext unexpected error', (e as Error)?.name); // 내용(인증값 포함 가능)은 로그에도 남기지 않음
    return json(500, { ok: false, error: { code: 'UNKNOWN', message: '서버에서 예상하지 못한 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' } });
  }
}

(globalThis as any).Deno?.serve(handle);
