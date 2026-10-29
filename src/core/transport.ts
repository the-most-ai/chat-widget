import { outsideZone } from './env';
import type {
  Conversation,
  EventsResponse,
  HistoryResponse,
  Part,
  RatingValue,
  ServerEvent,
  UploadResponse,
} from './types';

/**
 * Ошибка шлюза (RFC 9457, application/problem+json: {type, title, status, code, detail?})
 * или сетевая. Обрабатываем по code: unauthorized, forbidden, not_found, invalid_request,
 * rate_limited, conversation_closed, cursor_expired, file_too_large, unsupported_media_type.
 */
export class ApiError extends Error {
  constructor(
    /** HTTP-статус; 0 — сеть, таймаут или CORS. */
    readonly status: number,
    readonly code: string,
    message: string,
    /** Из Retry-After (429, 503), мс. */
    readonly retryAfterMs?: number,
    /** Сессию не открыть (Origin, подключение): без исправления настройки дальше не пойдём. */
    readonly fatal = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Повторять ли тот же запрос позже. */
  get retryable(): boolean {
    return !this.fatal && (this.status === 0 || this.status === 429 || this.status >= 500);
  }
}

/** Где живёт visitor_token посетителя (localStorage, ключ avai-chat:<tenant>:visitor). */
export interface VisitorTokenStore {
  get(): string | null;
  set(token: string): void;
  /** Забыть посетителя: следующая сессия откроется как у нового. */
  clear?(): void;
}

export interface TransportOptions {
  /** Адрес API вместе с версией, например https://chat-gateway.avangardai.ru/v1. */
  api: string;
  tenant: string;
  visitor: VisitorTokenStore;
  fetch?: typeof fetch;
}

export interface SendBody {
  client_msg_id: string;
  parts: Part[];
  context?: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Запас сверх wait для долгого опроса. */
const POLL_EXTRA_MS = 10_000;
const FILE_TIMEOUT_MS = 60_000;

/**
 * HTTP-клиент протокола v1.0. Сессия открывается при первом запросе (POST /v1/sessions):
 * session_token живёт только в памяти, visitor_token — в localStorage. На 401 сессия
 * открывается заново один раз, и запрос повторяется.
 */
export class Transport {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;
  private session: Promise<string> | null = null;
  /** Растёт при forgetVisitor: сессия, открытая для прежнего посетителя, не сохраняется. */
  private epoch = 0;

  constructor(private readonly opts: TransportOptions) {
    this.base = opts.api.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  createConversation(): Promise<Conversation> {
    return this.json<Conversation>('POST', '/conversations', {}, REQUEST_TIMEOUT_MS).then(checkConversation);
  }

  getConversation(id: string): Promise<Conversation> {
    return this.json<Conversation>('GET', `/conversations/${enc(id)}`, undefined, REQUEST_TIMEOUT_MS).then(checkConversation);
  }

  /** 201 — событие message.created своего сообщения; повтор того же client_msg_id — 200 и то же событие. */
  sendMessage(conversationId: string, body: SendBody): Promise<ServerEvent> {
    return this.json<ServerEvent>('POST', `/conversations/${enc(conversationId)}/messages`, body, REQUEST_TIMEOUT_MS);
  }

  /** after null — с начала хранимой ленты. */
  async events(conversationId: string, after: string | null, waitSec: number, signal?: AbortSignal): Promise<EventsResponse> {
    const q = new URLSearchParams();
    if (after !== null) q.set('after', after);
    if (waitSec > 0) q.set('wait', String(waitSec));
    const qs = q.toString();
    const d = await this.json<Partial<EventsResponse>>(
      'GET',
      `/conversations/${enc(conversationId)}/events${qs ? `?${qs}` : ''}`,
      undefined,
      waitSec * 1000 + POLL_EXTRA_MS,
      signal,
    );
    if (!d || typeof d.cursor !== 'string') throw new ApiError(200, 'bad_response', 'Некорректный ответ сервера');
    const events = Array.isArray(d.events) ? d.events.filter((e) => e && typeof e.id === 'string') : [];
    return { events, cursor: d.cursor };
  }

  /** История: сообщения в текущем состоянии, новые сверху. */
  async history(conversationId: string, limit: number, before?: string): Promise<HistoryResponse> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', before);
    const d = await this.json<Partial<HistoryResponse>>(
      'GET',
      `/conversations/${enc(conversationId)}/messages?${q}`,
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    const items = Array.isArray(d?.items) ? d.items.filter((m) => m && typeof m.id === 'string') : [];
    return { items, next: typeof d?.next === 'string' ? d.next : null };
  }

  /** Оценка в ответ на запрос (message_id — id сообщения-запроса). 204; повтор — 409 already_rated. */
  async feedback(conversationId: string, messageId: string, rating: RatingValue): Promise<void> {
    await this.json('POST', `/conversations/${enc(conversationId)}/feedback`, { message_id: messageId, rating }, REQUEST_TIMEOUT_MS);
  }

  /** Картинка — сами байты (не multipart и не base64), тип — из Blob, имя — в адресе. */
  async upload(blob: Blob, name: string): Promise<UploadResponse> {
    const res = await this.send('POST', `/uploads?${new URLSearchParams({ name: name.slice(0, 200) || 'image' })}`, blob, FILE_TIMEOUT_MS);
    const d = (await readJson(res)) as Partial<UploadResponse> | null;
    if (!d || typeof d.file_id !== 'string') throw new ApiError(res.status, 'bad_response', 'Некорректный ответ сервера');
    return d as UploadResponse;
  }

  async fetchFile(fileId: string, signal?: AbortSignal): Promise<Blob> {
    const res = await this.send('GET', `/files/${enc(fileId)}`, undefined, FILE_TIMEOUT_MS, signal);
    return res.blob();
  }

  /** Новый посетитель: забыть visitor_token и токен сессии (например, пользователь вышел из аккаунта). */
  forgetVisitor(): void {
    this.opts.visitor.clear?.();
    this.token = null;
    this.session = null;
    this.epoch++;
  }

  // ---------- сессия ----------

  private async sessionToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.session) {
      const s = this.openSession().finally(() => {
        if (this.session === s) this.session = null;
      });
      this.session = s;
    }
    return this.session;
  }

  private async openSession(): Promise<string> {
    const epoch = this.epoch;
    const visitorToken = this.opts.visitor.get();
    const body: Record<string, string> = { tenant: this.opts.tenant };
    if (visitorToken) body.visitor_token = visitorToken;
    const res = await this.fetchRaw('POST', '/sessions', JSON.stringify(body), 'application/json', null, REQUEST_TIMEOUT_MS);
    if (res.status !== 200 && res.status !== 201) {
      const err = await toApiError(res);
      // 403 (Origin), 404 (нет подключения), 401, 422 — настройка: повтор не поможет.
      const fatal = res.status < 500 && res.status !== 429;
      throw new ApiError(err.status, err.code, err.message, err.retryAfterMs, fatal);
    }
    const d = (await readJson(res)) as { session_token?: unknown; visitor_token?: unknown } | null;
    if (!d || typeof d.session_token !== 'string') throw new ApiError(res.status, 'bad_response', 'Некорректный ответ сервера');
    // Пока открывали, посетителя забыли (reset): эту сессию не запоминаем, запрос откроет новую.
    if (epoch !== this.epoch) return this.sessionToken();
    // visitor_token приходит только у нового посетителя (в том числе если прежний токен не признан).
    if (typeof d.visitor_token === 'string' && d.visitor_token) this.opts.visitor.set(d.visitor_token);
    this.token = d.session_token;
    return this.token;
  }

  // ---------- запросы ----------

  private async json<T>(method: string, path: string, body: unknown, timeoutMs: number, outer?: AbortSignal): Promise<T> {
    const res = await this.send(method, path, body === undefined ? undefined : JSON.stringify(body), timeoutMs, outer);
    return (await readJson(res)) as T;
  }

  /** Запрос с сессией. 401 — открыть сессию заново и повторить один раз. Не 2xx — ApiError. */
  private async send(
    method: string,
    path: string,
    body: string | Blob | undefined,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<Response> {
    const type = body === undefined ? null : typeof body === 'string' ? 'application/json' : body.type || 'application/octet-stream';
    for (let attempt = 0; ; attempt++) {
      const token = await this.sessionToken();
      const res = await this.fetchRaw(method, path, body, type, token, timeoutMs, outer);
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status === 401 && attempt === 0) {
        if (this.token === token) this.token = null;
        await res.body?.cancel().catch(() => {});
        continue;
      }
      throw await toApiError(res);
    }
  }

  private async fetchRaw(
    method: string,
    path: string,
    body: string | Blob | undefined,
    contentType: string | null,
    token: string | null,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = contentType;

    try {
      return await outsideZone(() =>
        this.fetchImpl(this.base + path, {
          method,
          headers,
          body,
          signal: ctrl.signal,
          credentials: 'omit',
          cache: 'no-store',
        }),
      );
    } catch (e) {
      if (outer?.aborted) throw e;
      throw new ApiError(0, timedOut ? 'timeout' : 'network', timedOut ? 'Превышено время ожидания' : 'Нет связи');
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function checkConversation(c: Conversation): Conversation {
  if (!c || typeof c.id !== 'string' || typeof c.cursor !== 'string') {
    throw new ApiError(200, 'bad_response', 'Некорректный ответ сервера');
  }
  return c;
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function toApiError(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => null);
  const p = (data ?? {}) as { code?: unknown; detail?: unknown; title?: unknown };
  const code = typeof p.code === 'string' ? p.code : `http_${res.status}`;
  const message =
    typeof p.detail === 'string' && p.detail
      ? p.detail
      : typeof p.title === 'string' && p.title
        ? p.title
        : `Ошибка ${res.status}`;
  return new ApiError(res.status, code, message, parseRetryAfter(res.headers.get('Retry-After')));
}

/** Retry-After: секунды или HTTP-дата. С другого origin читается только при Access-Control-Expose-Headers. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}
