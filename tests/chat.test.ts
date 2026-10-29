import { describe, expect, it, vi } from 'vitest';
import { ChatController, gatewayContext, neutralName, type ChatControllerOptions } from '../src/core/chat';
import { Store, type StorageLike } from '../src/core/store';
import { parseRetryAfter, Transport } from '../src/core/transport';
import type { Part } from '../src/core/types';

type Req = { method: string; url: string; path: string; headers: Record<string, string>; body: any };
type Resp = { status: number; body?: unknown; headers?: Record<string, string> };

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface Ev {
  cursor: string;
  id: string;
  type: string;
  conversation_id: string;
  ts: string;
  actor: { role: string; name: string | null };
  data: any;
}

/**
 * Шлюз v1.0 в памяти: сессии, диалоги, лента событий, загрузки. Бот отвечает через reply();
 * override() перехватывает запрос (ошибки и особые случаи).
 */
function fakeGateway() {
  let seq = 0;
  let convN = 0;
  let sessionN = 0;
  const g = {
    tokens: new Set<string>(),
    convs: new Map<string, { events: Ev[]; closed: boolean }>(),
    /** Ответ бота на сообщение посетителя: части или null (не отвечать). */
    reply: ((_parts: Part[]) => [{ type: 'text', text: 'ответ' }]) as (parts: Part[]) => Part[] | null,
    override: (_r: Req): Resp | undefined => undefined,
    push(conv: string, role: string, data: any, type = 'message.created', name: string | null = role === 'bot' ? 'Помощник' : null) {
      seq++;
      const ev: Ev = {
        cursor: `v1.${seq}`,
        id: `e${seq}`,
        type,
        conversation_id: conv,
        ts: new Date(Date.UTC(2026, 9, 28, 12, 0, seq)).toISOString(),
        actor: { role, name },
        data,
      };
      g.convs.get(conv)!.events.push(ev);
      return ev;
    },
    bot(conv: string, id: string, parts: Part[], fallback = '') {
      return g.push(conv, 'bot', { id, parts, fallback_text: fallback });
    },
    expireSessions() {
      g.tokens.clear();
    },
    handle(r: Req): Resp {
      const o = g.override(r);
      if (o) return o;
      if (r.path === '/sessions') {
        const token = `tok${++sessionN}`;
        g.tokens.add(token);
        return {
          status: 200,
          body: { session_token: token, expires_in: 3600, visitor_id: 'v1', ...(r.body.visitor_token ? {} : { visitor_token: 'cgv_new' }) },
        };
      }
      if (!g.tokens.has((r.headers.Authorization ?? '').replace('Bearer ', ''))) return problem(401, 'unauthorized');
      if (r.path === '/conversations' && r.method === 'POST') {
        const id = `c${++convN}`;
        g.convs.set(id, { events: [], closed: false });
        return { status: 201, body: conversation(id, `v1.${seq}`) };
      }
      if (r.path === '/uploads') return { status: 201, body: { file_id: 'up1', name: 'photo.jpg', mime_type: r.headers['Content-Type'], size: 4 } };
      if (r.path.startsWith('/files/')) return { status: 200, body: 'bytes' };
      const m = r.path.match(/^\/conversations\/([^/?]+)(\/[a-z]+)?/);
      const conv = m && g.convs.get(m[1]);
      if (!m || !conv) return problem(404, 'not_found');
      const id = m[1];
      const sub = m[2];
      if (!sub) return { status: 200, body: conversation(id, `v1.${seq}`, conv.closed ? 'closed' : 'open') };
      if (sub === '/messages' && r.method === 'POST') {
        if (conv.closed) return problem(409, 'conversation_closed');
        const dup = conv.events.find((e) => e.data.client_msg_id === r.body.client_msg_id);
        if (dup) return { status: 200, body: dup };
        const ev = g.push(id, 'visitor', { id: `s-${r.body.client_msg_id}`, client_msg_id: r.body.client_msg_id, parts: r.body.parts });
        const answer = g.reply(r.body.parts);
        if (answer) g.bot(id, `b${seq + 1}`, answer);
        return { status: 201, body: ev };
      }
      if (sub === '/messages') {
        const items = conv.events
          .filter((e) => e.type === 'message.created')
          .map((e) => ({ ...e.data, actor: e.actor, ts: e.ts, cursor: e.cursor }))
          .reverse();
        return { status: 200, body: { items, next: null } };
      }
      if (sub === '/events') {
        const after = new URL(r.url).searchParams.get('after');
        const n = after ? Number(after.split('.')[1]) : 0;
        const events = conv.events.filter((e) => Number(e.cursor.split('.')[1]) > n);
        return { status: 200, body: { events, cursor: events.length ? events[events.length - 1].cursor : after ?? 'v1.0' } };
      }
      if (sub === '/feedback') return { status: 204 };
      return problem(404, 'not_found');
    },
  };
  return g;
}

function conversation(id: string, cursor: string, status = 'open') {
  return { id, status, owner: 'bot', handoff_state: 'none', operator: null, handoff_available: false, created_at: '2026-10-28T12:00:00Z', cursor };
}

function setup(opts: Partial<ChatControllerOptions> = {}, storage = memoryStorage(), gw = fakeGateway()) {
  const calls: Req[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const req: Req = {
      method: init.method ?? 'GET',
      url,
      path: u.pathname.replace(/^\/v1/, ''),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(req);
    const r = gw.handle(req);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  const store = new Store('t1', storage);
  const transport = new Transport({ api: 'https://gw.test/v1/', tenant: 't1', fetch: fetchImpl, visitor: store.visitor });
  const c = new ChatController({
    transport,
    store,
    backoffMs: [5, 5, 5],
    minRetryMs: 0,
    pollIntervalMs: 20,
    hookTimeoutMs: 50,
    pollWaitSec: 0,
    ...opts,
  });
  return { c, calls, storage, store, gw };
}

const problem = (status: number, code: string, retryAfter?: string): Resp => ({
  status,
  body: { type: `urn:x:${code}`, title: code, status, code, detail: `detail ${code}` },
  headers: { 'Content-Type': 'application/problem+json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
});

/** Отправки сообщений. */
const sends = (calls: Req[]) => calls.filter((x) => x.method === 'POST' && /\/conversations\/[^/]+\/messages$/.test(x.path));
const bots = (c: ChatController) => c.state.messages.filter((m) => m.sender !== 'user');

const until = async (cond: () => boolean, ms = 1000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('transport', () => {
  it('Retry-After: секунды и HTTP-дата', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('ChatController v1', () => {
  it('сессия → диалог → отправка частями; ответ бота только из ленты', async () => {
    const { c, calls, storage } = setup();
    expect(await c.send('  привет  ')).toBe(true);
    expect(c.state.awaiting).toBe(true);
    await until(() => bots(c).length === 1);

    expect(calls[0].path).toBe('/sessions');
    expect(calls[0].body).toEqual({ tenant: 't1' });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(storage.data.get('avai-chat:t1:visitor')).toBe('cgv_new');

    expect(calls[1].path).toBe('/conversations');
    expect(calls[1].headers.Authorization).toBe('Bearer tok1');
    const send = sends(calls)[0];
    expect(send.path).toBe('/conversations/c1/messages');
    expect(send.body).toEqual({ client_msg_id: c.state.messages[0].id, parts: [{ type: 'text', text: 'привет' }] });
    expect(send.headers['X-Tenant']).toBeUndefined();
    expect(send.headers['X-Chat-Id']).toBeUndefined();

    const [own, answer] = c.state.messages;
    expect(own.status).toBe('sent');
    expect(own.serverId).toBe(`s-${own.id}`);
    expect(answer).toMatchObject({ sender: 'ai', text: 'ответ', name: 'Помощник' });
    expect(c.state.conversationId).toBe('c1');
    expect(c.state.awaiting).toBe(false);
    // Своё сообщение из ленты не задвоилось.
    expect(c.state.messages.filter((m) => m.sender === 'user')).toHaveLength(1);
    const saved = JSON.parse(storage.data.get('avai-chat:v2:t1')!);
    expect(saved.conversationId).toBe('c1');
    expect(saved.cursor).toBe('v1.2');
  });

  it('до первого сообщения ничего не запрашивает (ни сессии, ни диалога)', async () => {
    const { c, calls } = setup();
    c.setActive(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    c.setActive(false);
  });

  it('повторный визит: сессия по сохранённому visitor_token', async () => {
    const storage = memoryStorage();
    storage.setItem('avai-chat:t1:visitor', 'cgv_old');
    const { c, calls } = setup({}, storage);
    await c.send('x');
    await until(() => sends(calls).length === 1);
    expect(calls[0].body).toEqual({ tenant: 't1', visitor_token: 'cgv_old' });
    expect(storage.data.get('avai-chat:t1:visitor')).toBe('cgv_old');
  });

  it('401 → новая сессия один раз и повтор запроса', async () => {
    const { c, calls, gw } = setup();
    await c.send('раз');
    await until(() => bots(c).length === 1);
    gw.expireSessions();
    await c.send('два');
    await until(() => bots(c).length === 2);
    const sessions = calls.filter((x) => x.path === '/sessions');
    expect(sessions).toHaveLength(2);
    expect(sessions[1].body).toEqual({ tenant: 't1', visitor_token: 'cgv_new' });
    expect(sends(calls)[sends(calls).length - 1].headers.Authorization).toBe('Bearer tok2');
    expect(c.state.blocked).toBe(false);
  });

  it('401 и после новой сессии → ошибка настройки', async () => {
    const { c, gw } = setup();
    gw.override = (r) => (r.path === '/conversations' ? problem(401, 'unauthorized') : undefined);
    await c.send('x');
    await until(() => c.state.blocked);
    expect(c.state.notice?.kind).toBe('config');
    expect(await c.send('ещё')).toBe(false);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('сессия %i → ошибка настройки без повторов', async (status, code) => {
    const { c, calls, gw } = setup();
    gw.override = (r) => (r.path === '/sessions' ? problem(status, code) : undefined);
    await c.send('x');
    await until(() => c.state.blocked);
    expect(calls).toHaveLength(1);
    expect(c.state.messages[0].final).toBe(true);
  });

  it('лента: курсор, оператор с именем, system по центру без хука, незнакомое — fallback_text, неизвестный тип пропускается', async () => {
    const { c, calls, gw } = setup({ pollIntervalMs: 1000 });
    const seenByHook: string[] = [];
    c.setHooks({ afterReceive: (t) => (seenByHook.push(t), t) });
    gw.reply = () => null;
    c.setActive(true);
    await c.send('вопрос');
    await until(() => c.state.messages[0].status === 'sent');
    gw.push('c1', 'operator', { id: 'o1', parts: [{ type: 'text', text: 'Здравствуйте' }] }, 'message.created', 'Ольга');
    gw.push('c1', 'system', { id: 's1', parts: [{ type: 'system', code: 'bot_unavailable', text: 'Ассистент недоступен' }] }, 'message.created', null);
    gw.push('c1', 'bot', { id: 'k1', parts: [{ type: 'card', title: 'x' }], fallback_text: 'Карточка тарифа' });
    gw.push('c1', 'bot', {}, 'typing');
    gw.push('c1', 'system', { status: 'open', owner: 'bot' }, 'conversation.updated', null);
    await until(() => bots(c).length === 3, 2000);
    const [op, sys, card] = bots(c);
    expect(op).toMatchObject({ sender: 'operator', name: 'Ольга', text: 'Здравствуйте' });
    expect(sys).toMatchObject({ sender: 'system', systemCode: 'bot_unavailable', text: 'Ассистент недоступен' });
    expect(card).toMatchObject({ sender: 'ai', text: 'Карточка тарифа' });
    expect(seenByHook).toEqual(['Здравствуйте', 'Карточка тарифа']);
    const events = calls.filter((x) => x.path.endsWith('/events'));
    expect(events[0].url).toContain('after=v1.0');
    c.setActive(false);
  });

  it('typing и read шлюза: «печатает» до ответа или срока, «прочитано» у своих сообщений', async () => {
    const { c, gw } = setup({ awaitMaxMs: 10 });
    gw.reply = () => null;
    c.setActive(true);
    await c.send('раз');
    await c.send('два');
    await until(() => c.state.messages.every((m) => m.status === 'sent'));
    await new Promise((r) => setTimeout(r, 20));
    // Своё ожидание истекло — индикатор держит только событие шлюза.
    expect(c.state.awaiting).toBe(false);
    gw.push('c1', 'bot', { state: 'start', expires_in: 0.2 }, 'typing');
    await until(() => c.state.awaiting);
    await until(() => !c.state.awaiting, 1000);

    const [first, second] = c.state.messages;
    gw.push('c1', 'bot', { up_to: first.serverId }, 'read');
    await until(() => c.state.messages[0].read === true);
    expect(c.state.messages[1].read).toBeUndefined();
    gw.push('c1', 'visitor', { up_to: second.serverId }, 'read');
    gw.push('c1', 'bot', { state: 'start', expires_in: 30 }, 'typing');
    await until(() => c.state.awaiting);
    gw.bot('c1', 'b-late', [{ type: 'text', text: 'ответ' }]);
    await until(() => bots(c).length === 1);
    expect(c.state.awaiting).toBe(false);
    // read от посетителя — не «прочитано» для его же сообщений.
    expect(c.state.messages[1].read).toBeUndefined();
    c.setActive(false);
  });

  it('ответ при закрытом окне: лента в фоне, пока ждём, и счётчик непрочитанного', async () => {
    const { c } = setup();
    await c.send('вопрос');
    await until(() => bots(c).length === 1);
    expect(c.state.unread).toBe(1);
    c.setActive(true);
    expect(c.state.unread).toBe(0);
    c.setActive(false);
  });

  it('410 cursor_expired → курсор из диалога, история, дальше лента', async () => {
    const storage = memoryStorage();
    const first = setup({}, storage);
    await first.c.send('x');
    await until(() => bots(first.c).length === 1);
    first.c.destroy();

    let expired = true;
    const second = setup({}, storage, first.gw);
    first.gw.override = (r) => (expired && r.path.endsWith('/events') ? ((expired = false), problem(410, 'cursor_expired')) : undefined);
    first.gw.bot('c1', 'late', [{ type: 'text', text: 'позднее' }]);
    second.c.setActive(true);
    await until(() => bots(second.c).length === 2);
    const paths = second.calls.map((x) => `${x.method} ${x.path}`);
    expect(paths).toContain('GET /conversations/c1');
    expect(paths).toContain('GET /conversations/c1/messages');
    expect(bots(second.c).map((m) => m.text)).toEqual(['ответ', 'позднее']);
    second.c.setActive(false);
  });

  it('открытие: история с сервера восполняет кэш, по времени, без дублей', async () => {
    const storage = memoryStorage();
    const gw = fakeGateway();
    const first = setup({}, storage, gw);
    await first.c.send('раз');
    await until(() => bots(first.c).length === 1);
    first.c.destroy();
    // Пока посетителя не было: ответ из другой вкладки и ещё одно сообщение.
    gw.push('c1', 'visitor', { id: 'sv2', client_msg_id: 'other-tab', parts: [{ type: 'text', text: 'два' }] });
    gw.bot('c1', 'b9', [{ type: 'text', text: 'ответ на два' }]);
    const saved = JSON.parse(storage.getItem('avai-chat:v2:t1')!);
    storage.setItem('avai-chat:v2:t1', JSON.stringify({ ...saved, messages: saved.messages.slice(0, 1) }));

    const second = setup({}, storage, gw);
    second.c.setActive(true);
    await until(() => second.c.state.messages.length === 4);
    expect(second.c.state.messages.map((m) => `${m.sender}:${m.text}`)).toEqual(['user:раз', 'ai:ответ', 'user:два', 'ai:ответ на два']);
    second.c.setActive(false);
  });

  it('409 conversation_closed → новый диалог и повтор того же client_msg_id', async () => {
    const { c, calls, gw } = setup();
    await c.send('раз');
    await until(() => bots(c).length === 1);
    gw.convs.get('c1')!.closed = true;
    await c.send('два');
    await until(() => bots(c).length === 2);
    const s = sends(calls);
    expect(s.map((x) => x.path)).toEqual(['/conversations/c1/messages', '/conversations/c1/messages', '/conversations/c2/messages']);
    expect(s[1].body.client_msg_id).toBe(s[2].body.client_msg_id);
    expect(c.state.conversationId).toBe('c2');
  });

  it('beforeSend: отправляется очищенный текст, а при ошибке и таймауте — ничего', async () => {
    const { c, calls } = setup();
    c.setHooks({ beforeSend: async (t) => t.replace(/\d+/g, '#') });
    await c.send('номер 89161234567');
    await until(() => sends(calls).length === 1);
    expect(sends(calls)[0].body.parts).toEqual([{ type: 'text', text: 'номер #' }]);
    expect(c.state.messages[0].text).toBe('номер 89161234567');

    c.setHooks({
      beforeSend: () => {
        throw new Error('down');
      },
    });
    expect(await c.send('секрет 1')).toBe(false);
    expect(c.state.notice?.kind).toBe('hook');

    c.setHooks({ beforeSend: () => new Promise<string>(() => {}) });
    expect(await c.send('секрет 2')).toBe(false);
    expect(sends(calls)).toHaveLength(1);
  });

  it('requireHooks: без хука сообщение не уходит, входящее не показывается', async () => {
    const { c, calls } = setup({ requireHooks: true });
    expect(await c.send('текст')).toBe(false);
    expect(calls.length).toBe(0);
    c.setHooks({ beforeSend: (t) => t });
    await c.send('текст');
    await until(() => bots(c).length === 1);
    expect(bots(c)[0]).toMatchObject({ unprocessed: true, text: '' });
  });

  it('503 → повтор с тем же client_msg_id', async () => {
    let n = 0;
    const { c, calls, gw } = setup();
    gw.override = (r) => (r.method === 'POST' && r.path.endsWith('/messages') && ++n < 3 ? problem(503, 'unavailable', '0.02') : undefined);
    await c.send('привет');
    await until(() => bots(c).length === 1);
    expect(sends(calls)).toHaveLength(3);
    expect(new Set(sends(calls).map((x) => x.body.client_msg_id)).size).toBe(1);
    expect(c.state.notice).toBeNull();
  });

  it('5xx дольше всех повторов → failed, повтор по кнопке', async () => {
    let ok = false;
    const { c, gw } = setup();
    gw.override = (r) => (!ok && r.path.endsWith('/messages') ? problem(503, 'unavailable') : undefined);
    await c.send('привет');
    await until(() => c.state.messages[0].status === 'failed');
    expect(c.state.notice?.kind).toBe('error');
    ok = true;
    c.retry(c.state.messages[0].id);
    await until(() => bots(c).length === 1);
  });

  it('422 invalid_request → ошибка без повтора: посетителю понятный текст, detail — в событие error', async () => {
    const { c, calls, gw } = setup();
    gw.override = (r) => (r.path.endsWith('/messages') ? problem(422, 'invalid_request') : undefined);
    const errors: unknown[] = [];
    c.subscribe((e) => e.type === 'error' && errors.push(e.detail));
    await c.send('x');
    await until(() => c.state.messages[0].status === 'failed');
    expect(sends(calls)).toHaveLength(1);
    expect(c.state.messages[0]).toMatchObject({ error: c.texts.sendRejected, final: true });
    expect(errors).toEqual([{ code: 'invalid_request', message: 'detail invalid_request', status: 422 }]);
  });

  it('429 → ждёт Retry-After и отправляет снова', async () => {
    let n = 0;
    const { c, calls, gw } = setup();
    gw.override = (r) => (r.path.endsWith('/messages') && r.method === 'POST' && ++n === 1 ? problem(429, 'rate_limited', '0.05') : undefined);
    await c.send('x');
    await until(() => c.state.notice?.kind === 'rate-limit');
    await until(() => bots(c).length === 1);
    expect(sends(calls)).toHaveLength(2);
  });

  it('перезагрузка: неотправленное досылается в тот же диалог с тем же client_msg_id', async () => {
    const storage = memoryStorage();
    const gw = fakeGateway();
    gw.override = (r) => (r.path.endsWith('/messages') && r.method === 'POST' ? problem(503, 'unavailable') : undefined);
    const first = setup({ backoffMs: [1000] }, storage, gw);
    await first.c.send('после перезагрузки');
    await until(() => sends(first.calls).length === 1);
    first.c.destroy();

    gw.override = () => undefined;
    const second = setup({}, storage, gw);
    expect(second.c.state.conversationId).toBe('c1');
    await until(() => bots(second.c).length === 1);
    expect(sends(second.calls)[0].body.client_msg_id).toBe(sends(first.calls)[0].body.client_msg_id);
    expect(second.calls.some((x) => x.path === '/conversations' && x.method === 'POST')).toBe(false);
  });

  it('afterReceive падает → заглушка вместо исходного текста, повтор показывает', async () => {
    let fail = true;
    const { c, gw } = setup();
    gw.reply = () => [{ type: 'text', text: 'сырой' }];
    c.setHooks({
      afterReceive: async (t) => {
        if (fail) throw new Error('x');
        return t.toUpperCase();
      },
    });
    await c.send('x');
    await until(() => bots(c).length === 1);
    const id = bots(c)[0].id;
    expect(bots(c)[0]).toMatchObject({ unprocessed: true, text: '' });
    fail = false;
    await c.retryReceive(id);
    expect(bots(c)[0].text).toBe('СЫРОЙ');
  });

  describe('вложения', () => {
    const image = () => ({ blob: new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/jpeg' }), name: 'фото 1.jpg', thumb: 'data:image/jpeg;base64,AA' });

    it('картинка: байты в /uploads, затем часть file; превью остаётся своим', async () => {
      const { c, calls } = setup();
      expect(await c.send('смотри', image())).toBe(true);
      await until(() => sends(calls).length === 1);
      const up = calls.find((x) => x.path === '/uploads')!;
      expect(up.method).toBe('POST');
      // Имя файла посетителя не уходит: в нём бывают ПДн, а маскирование его не видит.
      expect(new URL(up.url).searchParams.get('name')).toBe('image.jpg');
      expect(up.headers['Content-Type']).toBe('image/jpeg');
      expect(up.body).toBeInstanceOf(Blob);
      expect(up.headers.Authorization).toBe('Bearer tok1');
      expect(sends(calls)[0].body.parts).toEqual([
        { type: 'text', text: 'смотри' },
        { type: 'file', file_id: 'up1' },
      ]);
      expect(c.state.messages[0].attachments).toEqual([
        { id: 'up1', name: 'фото 1.jpg', mimeType: 'image/jpeg', size: 4, thumb: 'data:image/jpeg;base64,AA' },
      ]);
    });

    it('413/415 → «изображение не принято» без повтора', async () => {
      const { c, gw } = setup();
      gw.override = (r) => (r.path === '/uploads' ? problem(415, 'unsupported_media_type') : undefined);
      await c.send('', image());
      await until(() => c.state.messages[0].status === 'failed');
      expect(c.state.messages[0]).toMatchObject({ final: true, error: c.texts.attachRejected });
    });

    it('beforeAttach вернул null или упал → ничего не уходит', async () => {
      const { c, calls } = setup();
      c.setHooks({ beforeAttach: () => null });
      expect(await c.send('текст', image())).toBe(false);
      expect(c.state.notice?.kind).toBe('hook');
      c.setHooks({
        beforeAttach: () => {
          throw new Error('x');
        },
      });
      expect(await c.send('', image())).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('requireHooks без beforeAttach → картинка не уходит', async () => {
      const { c, calls } = setup({ requireHooks: true });
      c.setHooks({ beforeSend: (t) => t });
      expect(await c.send('x', image())).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('перезагрузка до загрузки — «не отправлено»; после загрузки — досылается по file_id', async () => {
      const storage = memoryStorage();
      const gw = fakeGateway();
      gw.override = (r) => (r.path === '/conversations' && r.method === 'POST' ? problem(503, 'unavailable') : undefined);
      const first = setup({ backoffMs: [1000] }, storage, gw);
      await first.c.send('', image());
      await until(() => first.calls.some((x) => x.path === '/conversations'));
      first.c.destroy();
      gw.override = () => undefined;
      const second = setup({}, storage, gw);
      await until(() => second.c.state.messages[0].status === 'failed');
      expect(second.c.state.messages[0].final).toBe(true);

      const storage2 = memoryStorage();
      const gw2 = fakeGateway();
      gw2.override = (r) => (r.path.endsWith('/messages') && r.method === 'POST' ? problem(503, 'unavailable') : undefined);
      const third = setup({ backoffMs: [1000] }, storage2, gw2);
      await third.c.send('', image());
      await until(() => sends(third.calls).length === 1);
      third.c.destroy();
      gw2.override = () => undefined;
      const fourth = setup({}, storage2, gw2);
      await until(() => bots(fourth.c).length === 1);
      expect(fourth.calls.some((x) => x.path === '/uploads')).toBe(false);
      expect(sends(fourth.calls)[0].body.parts).toEqual([{ type: 'file', file_id: 'up1' }]);
    });

    it('входящий файл: часть file → вложение, загрузка /files/{id} с сессией', async () => {
      const { c, calls, gw } = setup();
      gw.reply = () => [{ type: 'file', file_id: 'f1', name: 'план.pdf', mime_type: 'application/pdf', size: 10, url: '/v1/files/f1' }];
      await c.send('пришли');
      await until(() => bots(c).length === 1);
      expect(bots(c)[0].attachments).toEqual([{ id: 'f1', name: 'план.pdf', mimeType: 'application/pdf', size: 10 }]);
      const url = await c.loadFile('f1');
      expect(url.startsWith('blob:')).toBe(true);
      const req = calls.find((x) => x.path.startsWith('/files/'))!;
      expect(req.url).toBe('https://gw.test/v1/files/f1');
      expect(req.headers.Authorization).toBe('Bearer tok1');
    });
  });

  describe('оценка диалога', () => {
    const askRating = (scale = 'like_dislike') => () => [{ type: 'rating_request', scale, rated: null }];

    it('запрос оценки — карточка, ответ уходит в …/feedback один раз', async () => {
      const { c, calls, gw } = setup();
      gw.reply = askRating('stars');
      const events: unknown[] = [];
      c.subscribe((e) => e.type === 'rating' && events.push(e.detail));
      await c.send('спасибо');
      await until(() => bots(c).length === 1);
      const id = bots(c)[0].id;
      expect(bots(c)[0].ratingRequest).toEqual({ scale: 'stars' });
      await c.rate(id, { stars: 4 });
      const fb = calls.filter((x) => x.path.endsWith('/feedback'));
      expect(fb).toHaveLength(1);
      expect(fb[0].path).toBe('/conversations/c1/feedback');
      expect(fb[0].body).toEqual({ message_id: id, rating: { stars: 4 } });
      expect(bots(c)[0].ratingRequest).toEqual({ scale: 'stars', value: { stars: 4 } });
      expect(events).toEqual([{ messageId: id, rating: { stars: 4 } }]);
      await c.rate(id, { stars: 1 });
      expect(calls.filter((x) => x.path.endsWith('/feedback'))).toHaveLength(1);
    });

    it('message.updated с rated (оценили в другой вкладке) закрывает карточку', async () => {
      const { c, gw } = setup();
      gw.reply = askRating();
      c.setActive(true);
      await c.send('x');
      await until(() => bots(c).length === 1);
      const id = bots(c)[0].id;
      gw.push('c1', 'bot', { id, parts: [{ type: 'rating_request', scale: 'like_dislike', rated: { liked: true } }] }, 'message.updated');
      await until(() => !!bots(c)[0].ratingRequest?.value);
      expect(bots(c)[0].ratingRequest).toEqual({ scale: 'like_dislike', value: { liked: true } });
      expect(bots(c)).toHaveLength(1);
      c.setActive(false);
    });

    it('409 already_rated — считается оценённым', async () => {
      const { c, gw } = setup();
      gw.reply = askRating();
      gw.override = (r) => (r.path.endsWith('/feedback') ? problem(409, 'already_rated') : undefined);
      await c.send('x');
      await until(() => bots(c).length === 1);
      await c.rate(bots(c)[0].id, { liked: true });
      expect(bots(c)[0].ratingRequest?.value).toEqual({ liked: true });
      expect(c.state.notice).toBeNull();
    });

    it('ошибка — оценка откатывается, посетителю предлагается повторить', async () => {
      const { c, gw } = setup();
      gw.reply = askRating();
      gw.override = (r) => (r.path.endsWith('/feedback') ? problem(422, 'invalid_request') : undefined);
      await c.send('x');
      await until(() => bots(c).length === 1);
      await c.rate(bots(c)[0].id, { liked: false });
      expect(bots(c)[0].ratingRequest).toEqual({ scale: 'like_dislike' });
      expect(c.state.notice?.kind).toBe('error');
    });
  });

  it('приглашение: локальное сообщение ничего не запрашивает, первый ответ несёт его контекст', async () => {
    const { c, calls } = setup();
    c.setContext({ site: 'demo' });
    c.addProactiveMessage('tariffs', 'Помочь выбрать тариф?', { proactive: 'tariffs', page: 'https://x/tariffs' });
    expect(c.proactiveShown('tariffs')).toBe(true);
    c.setActive(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    await c.send('да, помогите');
    await until(() => sends(calls).length === 1);
    expect(sends(calls)[0].body.context).toEqual({ site: 'demo', proactive: 'tariffs', page: 'https://x/tariffs' });
    await until(() => bots(c).length === 2);
    await c.send('ещё вопрос');
    await until(() => sends(calls).length === 2);
    expect(sends(calls)[1].body.context).toEqual({ site: 'demo' });
    c.setActive(false);
  });

  it('согласие: без него не отправляет', async () => {
    const { c, calls } = setup({ consentUrl: 'https://x/consent' });
    expect(c.state.consentAccepted).toBe(false);
    expect(await c.send('x')).toBe(false);
    c.acceptConsent();
    expect(c.state.consentAccepted).toBe(true);
    expect(await c.send('x')).toBe(true);
    await until(() => sends(calls).length === 1);
  });

  it('reset → новый посетитель: пустая история, visitor_token забыт, новая сессия и новый диалог', async () => {
    const { c, calls, storage } = setup();
    await c.send('x');
    await until(() => bots(c).length === 1);
    expect(storage.getItem('avai-chat:t1:visitor')).toBe('cgv_new');
    c.reset();
    expect(c.state.conversationId).toBeNull();
    expect(c.state.messages).toHaveLength(0);
    expect(storage.getItem('avai-chat:t1:visitor')).toBeNull();
    await c.send('новый');
    await until(() => bots(c).length === 1);
    expect(c.state.conversationId).toBe('c2');
    const sessions = calls.filter((x) => x.path === '/sessions');
    expect(sessions).toHaveLength(2);
    expect(sessions[1].body).toEqual({ tenant: 't1' });
  });

  it('reset спрашивает согласие на обработку ПД заново', async () => {
    const { c } = setup({ consentUrl: 'https://x/pd' });
    c.acceptConsent();
    expect(c.state.consentAccepted).toBe(true);
    c.reset();
    expect(c.state.consentAccepted).toBe(false);
  });
});

describe('исправления после ревью', () => {
  it('context под контракт шлюза: строки, обрезка до 500, не больше 20 ключей, контекст сообщения первым', () => {
    const base: Record<string, unknown> = { authorized: true, region_id: 77, tags: ['a', 'b'], empty: null, long: 'x'.repeat(600) };
    for (let i = 0; i < 30; i++) base[`k${i}`] = `v${i}`;
    const ctx = gatewayContext(base, { proactive: 'p1' })!;
    expect(Object.keys(ctx)).toHaveLength(20);
    expect(Object.keys(ctx)[0]).toBe('proactive');
    expect(ctx.authorized).toBe('true');
    expect(ctx.region_id).toBe('77');
    expect(ctx.tags).toBe('["a","b"]');
    expect(ctx.long).toHaveLength(500);
    expect('empty' in ctx).toBe(false);
    expect(gatewayContext({})).toBeUndefined();
  });

  it('setContext с числом и флагом не ломает отправку', async () => {
    const { c, calls } = setup();
    c.setContext({ authorized: true, region_id: 77 });
    await c.send('x');
    await until(() => bots(c).length === 1);
    expect(sends(calls)[0].body.context).toEqual({ authorized: 'true', region_id: '77' });
  });

  it('нейтральное имя картинки по типу', () => {
    expect(neutralName('image/png')).toBe('image.png');
    expect(neutralName('image/gif')).toBe('image.gif');
    expect(neutralName('image/jpeg')).toBe('image.jpg');
  });

  it('reset во время повтора отправки: новое сообщение не зависает', async () => {
    let fail = true;
    const { c, gw } = setup({ backoffMs: [200, 200] });
    gw.override = (r) => (fail && r.path.endsWith('/messages') && r.method === 'POST' ? problem(503, 'unavailable') : undefined);
    await c.send('старое');
    await until(() => c.state.notice?.kind === 'retrying');
    c.reset();
    fail = false;
    await c.send('новое');
    await until(() => bots(c).length === 1, 2000);
    expect(c.state.messages[0]).toMatchObject({ text: 'новое', status: 'sent' });
  });

  it('«Повторить» у необработанного ответа работает и после перезагрузки: исходник — из истории шлюза', async () => {
    const storage = memoryStorage();
    const gw = fakeGateway();
    gw.reply = () => [{ type: 'text', text: 'секрет 123' }];
    const first = setup({}, storage, gw);
    first.c.setHooks({ afterReceive: () => Promise.reject(new Error('down')) });
    await first.c.send('x');
    await until(() => bots(first.c).length === 1);
    const id = bots(first.c)[0].id;
    expect(bots(first.c)[0].unprocessed).toBe(true);
    // Неочищенный текст в localStorage не попадает.
    expect(storage.getItem('avai-chat:v2:t1')).not.toContain('секрет');
    first.c.destroy();

    const second = setup({}, storage, gw);
    second.c.setHooks({ afterReceive: (t) => t.replace(/\d+/g, '#') });
    await second.c.retryReceive(id);
    expect(bots(second.c)[0]).toMatchObject({ text: 'секрет #', unprocessed: false });
  });

  it('вкладки: своё неотправленное не теряется при записи другой вкладки, а брошенное — досылается', async () => {
    const storage = memoryStorage();
    const gw = fakeGateway();
    gw.reply = () => null;
    let fail = true;
    gw.override = (r) => (fail && r.path.endsWith('/messages') && r.method === 'POST' ? problem(503, 'unavailable') : undefined);
    const a = setup({ backoffMs: [5000] }, storage, gw);
    await a.c.send('из вкладки A');
    await until(() => a.c.state.notice?.kind === 'retrying');

    // Вкладка B со своим состоянием (без сообщения A) перезаписывает хранилище.
    const b = setup({}, memoryStorage(), gw);
    b.storage.data.forEach((v, k) => storage.setItem(k, v));
    storage.setItem('avai-chat:v2:t1', JSON.stringify({ ...JSON.parse(storage.getItem('avai-chat:v2:t1')!), messages: [] }));
    a.c.reloadFromStorage();
    expect(a.c.state.messages.map((m) => m.text)).toEqual(['из вкладки A']);
    a.c.destroy();

    // Вкладку A закрыли, не дослав: вкладка B подхватывает и досылает.
    fail = false;
    b.c.destroy();
    const tabB = setup({}, memoryStorage(), gw);
    tabB.storage.setItem('avai-chat:v2:t1', storage.getItem('avai-chat:v2:t1')!);
    tabB.c.reloadFromStorage();
    await until(() => sends(tabB.calls).length === 1);
    expect(sends(tabB.calls)[0].body.parts).toEqual([{ type: 'text', text: 'из вкладки A' }]);
  });
});

describe('персональные данные в браузере', () => {
  it('в localStorage своё сообщение — после beforeSend, а не исходный ввод', async () => {
    const { c, storage } = setup();
    c.setHooks({ beforeSend: (t) => t.replace(/\d{4}/g, '****') });
    await c.send('карта 1234 5678');
    await until(() => bots(c).length === 1);
    // На экране — то, что ввёл посетитель, в хранилище — только очищенное.
    expect(c.state.messages[0].text).toBe('карта 1234 5678');
    const saved = storage.getItem('avai-chat:v2:t1')!;
    expect(saved).not.toContain('1234');
    expect(saved).toContain('карта **** ****');
  });

  it('квота localStorage: id диалога и курсор сохраняются ценой превью и старой истории', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 5000) throw new DOMException('quota', 'QuotaExceededError');
        data.set(k, v);
      },
      removeItem: (k: string) => void data.delete(k),
    };
    const store = new Store('t1', storage);
    const messages = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      sender: 'ai' as const,
      text: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      attachments: [{ name: 'a', mimeType: 'image/jpeg', thumb: 'data:image/jpeg;base64,' + 'A'.repeat(50) }],
    }));
    store.save({ v: 2, conversationId: 'c1', cursor: 'k9', messages, awaitingSince: null, consentUrl: null, autoOpened: false });
    const saved = store.load()!;
    expect(saved.conversationId).toBe('c1');
    expect(saved.cursor).toBe('k9');
    expect(saved.messages.length).toBeGreaterThan(0);
    expect(saved.messages.every((m) => !m.attachments?.[0].thumb)).toBe(true);
  });
});
