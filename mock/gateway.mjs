// Мок шлюза Avangard AI для разработки виджета. Повторяет браузерную часть протокола v1.0
// (документация API шлюза, /docs): сессии, диалоги, лента событий, загрузки, оценка,
// ошибки RFC 9457. Состояние в памяти процесса. Поведение — командами в тексте (см. HELP).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const TENANTS = new Set(['demo', 'my-site']);
const ATTACH_MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_POLL_WAIT_S = 25;
/** Размер страницы ленты по умолчанию. Маленький, чтобы /many проверял дочитывание. */
const PAGE_SIZE = Number(process.env.MOCK_PAGE_SIZE ?? 5);
const SESSION_TTL_S = Number(process.env.MOCK_SESSION_TTL_S ?? 3600);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_NAME = 'Ассистент';

export const HELP = `Команды мока (пишите в чат):
/slow      — ответ через 25 с (долгий опрос ленты)
/operator  — после ответа ассистента напишет оператор
/many      — 7 сообщений разом: лента дочитывает страницами
/html      — ответ с HTML и <script>: должен показаться как текст
/link      — ответ со ссылкой
/long      — длинный ответ
/md        — ответ с разметкой (жирный, списки, ссылки)
/card      — часть незнакомого типа: виджет покажет fallback_text
/503       — бот недоступен: служебное сообщение по центру
/401       — сессия «истекла»: виджет сам откроет новую и отправит
/403 /422  — ошибка с этим кодом
/429       — лимит: Retry-After 5 с, потом отправится
/close     — шлюз закроет диалог: следующее сообщение уйдёт в новый
/expire    — курсор устареет (410): виджет перечитает историю
/image     — бот пришлёт картинку (последнюю вашу или сгенерированную)
/doc       — бот пришлёт документ для скачивания
/rate      — запрос оценки диалога (лайк/дизлайк); /stars — звёздами
Картинку можно прикрепить скрепкой, вставить из буфера или перетащить в окно.`;

/** visitor_token (sha256) -> visitorId */
const visitorTokens = new Map();
/** session_token -> { visitorId, tenant, exp } */
const sessions = new Map();
/** id -> { id, visitorId, status, events: [], waiters: Set, createdAt, ratings: Map, expireOnce } */
const conversations = new Map();
/** Файлы для GET /v1/files/{id}: id -> { visitorId, name, mime, buf } */
const files = new Map();
/** Однократные ошибки по client_msg_id: следующий повтор проходит. */
const fired = new Map();
let seq = 0;

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), '[mock-gw]', ...a);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const cursorOf = (n) => `v1.${1000 + n}.0`;
function seqOf(cursor) {
  const m = /^v1\.(\d+)\.0$/.exec(cursor);
  return m && Number(m[1]) >= 1000 ? Number(m[1]) - 1000 : null;
}

function conversationView(c) {
  const last = c.events.length ? c.events[c.events.length - 1].seq : c.startSeq;
  return {
    id: c.id,
    status: c.status,
    owner: 'bot',
    handoff_state: 'none',
    operator: null,
    handoff_available: false,
    created_at: c.createdAt,
    cursor: cursorOf(last),
  };
}

function fallbackOf(parts) {
  return parts
    .map((p) =>
      p.type === 'text' || p.type === 'system'
        ? p.text
        : p.type === 'file'
          ? `[${p.name}]`
          : p.type === 'rating_request'
            ? 'Оцените, пожалуйста, диалог'
            : p.fallback ?? '',
    )
    .filter(Boolean)
    .join('\n');
}

/** Событие в ленту диалога и пробуждение долгих опросов. */
function pushEvent(conv, type, actor, data) {
  const n = ++seq;
  const ev = { seq: n, cursor: cursorOf(n), id: randomUUID(), type, conversation_id: conv.id, ts: new Date().toISOString(), actor, data };
  conv.events.push(ev);
  for (const w of conv.waiters) w();
  conv.waiters.clear();
  return ev;
}

const botActor = { role: 'bot', name: BOT_NAME };

function say(conv, parts, actor = botActor) {
  const data = { id: randomUUID(), parts, fallback_text: fallbackOf(parts) };
  return pushEvent(conv, 'message.created', actor, data);
}

const text = (t) => ({ type: 'text', text: t });

function filePart(visitorId, name, mime, buf) {
  const id = randomUUID();
  files.set(id, { visitorId, name, mime, buf });
  return { type: 'file', file_id: id, name, mime_type: mime, size: buf.length, url: `/v1/files/${id}` };
}

function once(key) {
  const n = fired.get(key) ?? 0;
  fired.set(key, n + 1);
  return n;
}

function replyText(t, raw) {
  if (t.includes('/html')) {
    return 'Вот разметка, которая не должна выполниться: <img src=x onerror="alert(\'xss\')"> <b>жирный</b> <script>alert(1)</script>';
  }
  if (t.includes('/link')) return 'Подробнее о тарифах: https://example.com/tariffs. Или в личном кабинете.';
  if (t.includes('/md')) {
    return [
      '## Тарифы для бизнеса',
      'Подойдут **два варианта**:',
      '1. **«Бизнес Старт»** — 990 ₽/мес, 30 ГБ',
      '2. **«Бизнес Про»** — 1 990 ₽/мес, *безлимит*',
      '',
      'Что ещё важно:',
      '- переход бесплатный, код услуги `*111*1#`',
      '- подробнее — [на сайте](https://example.com/tariffs), https://example.com или просто example.ru.',
      '',
      'Разметка не исполняется: <b>это</b> текст.',
    ].join('\n');
  }
  if (t.includes('/long')) {
    return Array.from({ length: 12 }, (_, i) => `${i + 1}. Длинный ответ ассистента, чтобы проверить прокрутку и перенос строк.`).join('\n');
  }
  if (t.includes('/help') || t === 'помощь') return HELP;
  const answers = [
    'Сменить тариф можно в мобильном приложении или в личном кабинете на сайте.',
    'Уточните, пожалуйста, о какой услуге идёт речь — мобильная связь, интернет или ТВ?',
    'Понял вас. Сейчас подскажу подходящие варианты.',
  ];
  return `${answers[Math.floor(Math.random() * answers.length)]}\n(мок: вы написали «${raw.slice(0, 80)}»; /help — команды)`;
}

/** Картинка-заглушка: PNG 240×160 с градиентом, без зависимостей. */
function samplePng() {
  const w = 240;
  const h = 160;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = 40 + Math.round((x / w) * 180);
      raw[row + 2 + x * 3] = 60 + Math.round((y / h) * 120);
      raw[row + 3 + x * 3] = 160;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Ответ бота приходит в ленту позже — как у настоящего шлюза. */
function scheduleReply(conv, raw, upload) {
  const t = raw.toLowerCase();
  const delay = t.includes('/slow') ? 25_000 : 1500 + Math.random() * 2500;
  setTimeout(() => {
    if (t.includes('/503')) {
      pushEvent(conv, 'message.created', { role: 'system', name: null }, {
        id: randomUUID(),
        parts: [{ type: 'system', code: 'bot_unavailable', text: 'Ассистент временно недоступен. Попробуйте написать чуть позже.' }],
        fallback_text: 'Ассистент временно недоступен. Попробуйте написать чуть позже.',
      });
    } else if (upload && !t.includes('/image')) {
      say(conv, [text(`Получил изображение «${upload.name}» (${Math.round(upload.buf.length / 1024)} КБ).${raw ? ` Текст: «${raw.slice(0, 80)}»` : ''}`)]);
    } else if (t.includes('/image')) {
      const img = conv.lastUpload ?? { name: 'пример.png', mime: 'image/png', buf: samplePng() };
      say(conv, [text('Вот изображение:'), filePart(conv.visitorId, img.name, img.mime, img.buf)]);
    } else if (t.includes('/rate') || t.includes('/stars')) {
      // Запрос оценки диалога — отдельное сообщение с одной частью rating_request.
      say(conv, [text('Рад был помочь!')]);
      say(conv, [{ type: 'rating_request', scale: t.includes('/stars') ? 'stars' : 'like_dislike', rated: null }]);
    } else if (t.includes('/doc')) {
      const doc = Buffer.from('Пример документа от ассистента.\nТариф «Бизнес» — 990 ₽/мес.\n', 'utf8');
      say(conv, [filePart(conv.visitorId, 'тарифы.txt', 'text/plain; charset=utf-8', doc)]);
    } else if (t.includes('/card')) {
      const parts = [{ type: 'card', title: 'Бизнес Про', fallback: 'Карточка тарифа «Бизнес Про»: 1 990 ₽/мес' }];
      pushEvent(conv, 'message.created', botActor, { id: randomUUID(), parts, fallback_text: 'Карточка тарифа «Бизнес Про»: 1 990 ₽/мес' });
    } else if (t.includes('/many')) {
      for (let i = 1; i <= 7; i++) say(conv, [text(`Сообщение ${i} из 7`)]);
    } else if (t.includes('/close')) {
      say(conv, [text('Закрываю диалог. Следующее сообщение откроет новый.')]);
      conv.status = 'closed';
      pushEvent(conv, 'conversation.updated', { role: 'system', name: null }, { status: 'closed', owner: 'bot', handoff_state: 'none' });
    } else {
      say(conv, [text(replyText(t, raw))]);
    }
    if (t.includes('/operator')) {
      setTimeout(() => say(conv, [text('Здравствуйте! Я оператор Анна, подключилась к диалогу. Чем помочь?')], { role: 'operator', name: 'Оператор Анна' }), 6000);
    }
  }, delay);
}

// ---------- HTTP ----------

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const TITLES = {
  unauthorized: 'Нет доступа',
  forbidden: 'Сайт не разрешён для подключения',
  not_found: 'Не найдено',
  invalid_request: 'Неверный запрос',
  rate_limited: 'Превышен лимит',
  conversation_closed: 'Диалог закрыт',
  cursor_expired: 'Курсор устарел',
  already_rated: 'Уже оценено',
  file_too_large: 'Файл слишком большой',
  unsupported_media_type: 'Тип файла не поддерживается',
};

/** Ошибка в формате RFC 9457, как у шлюза. */
function problem(res, status, code, detail, retryAfter) {
  const body = { type: `urn:most:chat-gateway:error:${code}`, title: TITLES[code] ?? code, status, code };
  if (detail) body.detail = detail;
  res.writeHead(status, {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(retryAfter !== undefined ? { 'Retry-After': String(retryAfter) } : {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 64_000);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

/** CORS как у шлюза: только разрешённые origin, preflight 204, Retry-After доступен скрипту. */
function cors(req, res, allowOrigin) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return true;
  if (!allowOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

const localOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

/**
 * Connect-совместимый обработчик: (req, res, next). prefix — путь API, например /v1.
 */
export function gatewayMiddleware({ prefix = '/v1', allowOrigin = localOrigin } = {}) {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(`${prefix}/`)) return next?.();
    const path = url.pathname.slice(prefix.length);
    if (!/^\/(sessions|conversations|uploads|files)(\/|$)/.test(path)) return next?.();

    const allowed = cors(req, res, allowOrigin);
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(allowed ? 204 : 403);
      return res.end();
    }
    if (!allowed) return problem(res, 403, 'forbidden');

    try {
      if (path === '/sessions' && req.method === 'POST') return await handleSession(req, res);
      const s = auth(req);
      if (!s) return problem(res, 401, 'unauthorized');
      if (path === '/uploads' && req.method === 'POST') return await handleUpload(req, res, url, s);
      if (path.startsWith('/files/') && req.method === 'GET') return handleFile(res, decodeURIComponent(path.slice(7)), s);
      if (path === '/conversations' && req.method === 'POST') return createConversation(res, s);
      const m = /^\/conversations\/([^/]+)(\/[a-z]+)?$/.exec(path);
      if (!m) return problem(res, 404, 'not_found');
      const conv = conversations.get(m[1]);
      if (!conv || conv.visitorId !== s.visitorId) return problem(res, 404, 'not_found', 'диалог');
      const sub = m[2] ?? '';
      if (sub === '' && req.method === 'GET') return json(res, 200, conversationView(conv));
      if (sub === '/messages' && req.method === 'POST') return await handleSend(req, res, conv, s);
      if (sub === '/messages' && req.method === 'GET') return handleHistory(res, url, conv);
      if (sub === '/events' && req.method === 'GET') return await handleEvents(req, res, url, conv);
      if (sub === '/feedback' && req.method === 'POST') return await handleFeedback(req, res, conv);
      return problem(res, 404, 'not_found');
    } catch (e) {
      if (e?.tooLarge) return problem(res, 413, 'file_too_large');
      if (e instanceof SyntaxError) return problem(res, 422, 'invalid_request', 'JSON');
      log('error', e);
      return problem(res, 500, 'internal');
    }
  };
}

function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const s = m && sessions.get(m[1]);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

async function handleSession(req, res) {
  const body = await readJson(req);
  if (!TENANTS.has(body?.tenant)) return problem(res, 404, 'not_found', 'подключение');
  let visitorId = typeof body.visitor_token === 'string' ? visitorTokens.get(sha(body.visitor_token)) : undefined;
  let visitorToken;
  if (!visitorId) {
    visitorId = randomUUID();
    visitorToken = `cgv_${randomBytes(32).toString('base64url')}`;
    visitorTokens.set(sha(visitorToken), visitorId);
    log('SESSION new visitor', visitorId.slice(0, 8));
  }
  const token = `mock.${randomBytes(24).toString('base64url')}`;
  sessions.set(token, { visitorId, tenant: body.tenant, exp: Date.now() + SESSION_TTL_S * 1000 });
  return json(res, 200, { session_token: token, expires_in: SESSION_TTL_S, visitor_id: visitorId, ...(visitorToken ? { visitor_token: visitorToken } : {}) });
}

function createConversation(res, s) {
  const id = randomUUID();
  const conv = { id, visitorId: s.visitorId, status: 'open', events: [], waiters: new Set(), createdAt: new Date().toISOString(), ratings: new Map(), startSeq: seq };
  conversations.set(id, conv);
  log('CONVERSATION', id.slice(0, 8));
  return json(res, 201, conversationView(conv));
}

async function handleUpload(req, res, url, s) {
  const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!ATTACH_MIME.has(mime)) return problem(res, 415, 'unsupported_media_type');
  const buf = await readBody(req, MAX_ATTACH_BYTES);
  if (!buf.length) return problem(res, 422, 'invalid_request', 'пустой файл');
  const name = (url.searchParams.get('name') || 'image').slice(0, 200);
  const id = randomUUID();
  files.set(id, { visitorId: s.visitorId, name, mime, buf, unbound: true });
  log('UPLOAD', name, mime, `${buf.length} B`);
  return json(res, 201, { file_id: id, name, mime_type: mime, size: buf.length });
}

async function handleSend(req, res, conv, s) {
  const body = await readJson(req);
  const { client_msg_id: cid, context } = body ?? {};
  // Как у шлюза: до 20 пар, значения — строки до 500 символов.
  if (context !== undefined && context !== null) {
    const entries = typeof context === 'object' && !Array.isArray(context) ? Object.entries(context) : null;
    if (!entries || entries.length > 20 || entries.some(([, v]) => typeof v !== 'string' || v.length > 500)) {
      return problem(res, 422, 'invalid_request', 'context: до 20 строк по 500 символов');
    }
  }
  if (!UUID_RE.test(cid ?? '')) return problem(res, 422, 'invalid_request', 'client_msg_id');
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const textPart = parts.filter((p) => p?.type === 'text');
  const filePartIn = parts.filter((p) => p?.type === 'file');
  if (!parts.length || parts.length > 2 || textPart.length > 1 || filePartIn.length > 1 || textPart.length + filePartIn.length !== parts.length) {
    return problem(res, 422, 'invalid_request', 'части сообщения');
  }
  const raw = textPart[0] ? String(textPart[0].text ?? '').trim() : '';
  if (textPart[0] && (!raw || raw.length > MAX_TEXT)) return problem(res, 422, 'invalid_request', `текст от 1 до ${MAX_TEXT}`);

  // Повтор с тем же client_msg_id — 200 и то же событие, без второй отправки боту.
  const dup = conv.events.find((e) => e.type === 'message.created' && e.data.client_msg_id === cid);
  if (dup) {
    log('SEND repeat', cid.slice(0, 8));
    return json(res, 200, dup);
  }
  if (conv.status === 'closed') return problem(res, 409, 'conversation_closed');

  let upload = null;
  const outParts = [];
  if (raw) outParts.push(text(raw));
  if (filePartIn[0]) {
    const f = files.get(filePartIn[0].file_id);
    if (!f || f.visitorId !== s.visitorId || !f.unbound) return problem(res, 422, 'invalid_request', 'вложение: file_id');
    f.unbound = false;
    upload = f;
    outParts.push({ type: 'file', file_id: filePartIn[0].file_id, name: f.name, mime_type: f.mime, size: f.buf.length, url: `/v1/files/${filePartIn[0].file_id}` });
  }

  const t = raw.toLowerCase();
  log('SEND', conv.id.slice(0, 8), cid.slice(0, 8), JSON.stringify(raw.slice(0, 60)), context ? JSON.stringify(context) : '', upload ? `+${upload.mime} ${upload.buf.length} B` : '');
  if (t.includes('/401') && once(`${cid}:401`) === 0) {
    // Сессия «истекла»: виджет откроет новую по visitor_token и повторит запрос.
    for (const [k, v] of sessions) if (v.visitorId === s.visitorId) sessions.delete(k);
    return problem(res, 401, 'unauthorized');
  }
  if (t.includes('/403')) return problem(res, 403, 'forbidden');
  if (t.includes('/422')) return problem(res, 422, 'invalid_request', 'мок: сообщение отклонено');
  if (t.includes('/429') && once(`${cid}:429`) === 0) return problem(res, 429, 'rate_limited', undefined, 5);
  if (t.includes('/expire')) conv.expireOnce = true;

  if (upload) conv.lastUpload = upload;
  const ev = pushEvent(conv, 'message.created', { role: 'visitor', name: null }, { id: randomUUID(), client_msg_id: cid, parts: outParts, fallback_text: fallbackOf(outParts) });
  // Как шлюз: «печатает» сразу, «прочитано», когда бот принял сообщение.
  pushEvent(conv, 'typing', botActor, { state: 'start', expires_in: 30 });
  setTimeout(() => pushEvent(conv, 'read', botActor, { up_to: ev.data.id }), 300);
  scheduleReply(conv, raw, upload);
  return json(res, 201, ev);
}

function messageView(ev, conv) {
  const rated = conv.ratings.get(ev.data.id);
  const parts = ev.data.parts.map((p) => (p.type === 'rating_request' ? { ...p, rated: rated ?? null } : p));
  return { ...ev.data, parts, actor: ev.actor, ts: ev.ts, cursor: ev.cursor };
}

function handleHistory(res, url, conv) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 100);
  const before = url.searchParams.get('before');
  const beforeSeq = before ? seqOf(before) : Infinity;
  if (beforeSeq === null) return problem(res, 422, 'invalid_request', 'before');
  const all = conv.events.filter((e) => e.type === 'message.created' && e.seq < beforeSeq).reverse();
  const page = all.slice(0, limit);
  const next = all.length > limit ? page[page.length - 1].cursor : null;
  return json(res, 200, { items: page.map((e) => messageView(e, conv)), next });
}

function waitNew(conv, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      conv.waiters.delete(finish);
      resolve();
    };
    const t = setTimeout(finish, ms);
    conv.waiters.add(finish);
  });
}

async function handleEvents(req, res, url, conv) {
  const rawAfter = url.searchParams.get('after');
  const from = rawAfter === null ? 0 : seqOf(rawAfter);
  if (from === null) return problem(res, 422, 'invalid_request', 'after');
  if (conv.expireOnce && rawAfter !== null) {
    conv.expireOnce = false;
    log('EVENTS 410', conv.id.slice(0, 8));
    return problem(res, 410, 'cursor_expired');
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? PAGE_SIZE) || PAGE_SIZE, 1), 100);
  const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, MAX_POLL_WAIT_S);
  const after = () => conv.events.filter((e) => e.seq > from);
  if (after().length === 0 && wait > 0) {
    let closed = false;
    req.on('close', () => (closed = true));
    await waitNew(conv, wait * 1000);
    if (closed) return;
  }
  const page = after().slice(0, limit);
  if (page.length) log('EVENTS', conv.id.slice(0, 8), `+${page.length}`);
  const events = page.map(({ seq: _s, ...e }) => e);
  return json(res, 200, { events, cursor: page.length ? page[page.length - 1].cursor : rawAfter ?? cursorOf(conv.startSeq) });
}

/** Оценка диалога в ответ на запрос: одна на запрос, повтор — 409 already_rated; в ленту — message.updated. */
async function handleFeedback(req, res, conv) {
  const body = await readJson(req);
  const { message_id: id, rating } = body ?? {};
  const request = conv.events.find((e) => e.type === 'message.created' && e.data.id === id && e.data.parts.some((p) => p.type === 'rating_request'));
  const scale = request?.data.parts.find((p) => p.type === 'rating_request').scale;
  const valid =
    rating &&
    ((scale === 'like_dislike' && typeof rating.liked === 'boolean') ||
      (scale === 'stars' && Number.isInteger(rating.stars) && rating.stars >= 1 && rating.stars <= 5));
  if (!request || !valid) return problem(res, 422, 'invalid_request', 'оценка');
  if (conv.ratings.has(id)) return problem(res, 409, 'already_rated', 'диалог уже оценён');
  conv.ratings.set(id, rating);
  log('FEEDBACK', conv.id.slice(0, 8), JSON.stringify(rating));
  const view = messageView(request, conv);
  pushEvent(conv, 'message.updated', request.actor, { id: view.id, parts: view.parts, fallback_text: view.fallback_text });
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/** Файл отдаётся только посетителю, которому он принадлежит, — как у шлюза. */
function handleFile(res, id, s) {
  const f = files.get(id);
  if (!f || f.visitorId !== s.visitorId) return problem(res, 404, 'not_found', 'файл');
  const disposition = `${f.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': f.buf.length,
    'Content-Disposition': disposition,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(f.buf);
}
