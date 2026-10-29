import { makeThumb } from './attachments';
import { isAbort, sleep, uuid, withTimeout } from './env';
import { Store, type Persisted } from './store';
import { DEFAULT_TEXTS, type Texts } from './texts';
import { ApiError, Transport, type SendBody } from './transport';
import type {
  Actor,
  ChatAttachment,
  ChatErrorEvent,
  ChatMessage,
  ChatMessageEvent,
  ChatState,
  Hooks,
  Notice,
  OutgoingAttachment,
  Part,
  RatingValue,
  ServerEvent,
  ServerMessage,
} from './types';

export const MAX_TEXT_LENGTH = 4000;
/** Сколько последних сообщений берём из истории шлюза при открытии. */
const HISTORY_LIMIT = 50;
/** Сколько последних сообщений просматриваем, чтобы найти исходник для повторной обработки. */
const HISTORY_RETRY_LIMIT = 100;

export interface ChatControllerOptions {
  transport: Transport;
  store: Store;
  hooks?: Hooks;
  /** Таймаут хуков маскирования, мс (спецификация: 5 с). */
  hookTimeoutMs?: number;
  /** Параметр wait долгого опроса, с. 0 — обычный опрос раз в pollIntervalMs. */
  pollWaitSec?: number;
  /** Минимальный промежуток между пустыми опросами, мс. */
  pollIntervalMs?: number;
  consentUrl?: string | null;
  texts?: Partial<Texts>;
  /** Задержки повторов при 5xx и обрыве связи, мс. Последняя повторяется для опроса. */
  backoffMs?: number[];
  /** Сколько ждём ответа ассистента, прежде чем погасить «печатает…», мс. */
  awaitMaxMs?: number;
  /** Без заданных хуков не отправлять и не показывать сообщения (fail-closed). */
  requireHooks?: boolean;
  /** Пауза перед любым повтором не меньше этого, мс: Retry-After: 0 не даст плотного цикла. */
  minRetryMs?: number;
}

export type ControllerEvent =
  | { type: 'change' }
  | { type: 'rating'; detail: { messageId: string; rating: RatingValue } }
  | { type: 'message'; detail: ChatMessageEvent }
  | { type: 'error'; detail: ChatErrorEvent };

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
/** Сколько показываем «Печатает…» после отправки без события typing от шлюза, мс. */
const TYPING_FALLBACK_MS = 30_000;

/** Входящее, которое afterReceive не обработал: для повтора. */
interface RawIncoming {
  message: ServerMessage;
  actor: Actor;
  text: string;
}

/**
 * Логика диалога без интерфейса (протокол v1.0): отправка с повторами, лента событий,
 * история, хуки. Интерфейс подписывается на изменения и рисует `state`.
 *
 * Диалог — сущность шлюза: создаётся первым сообщением (POST /v1/conversations), «новый чат» —
 * новый диалог. Отправка только кладёт сообщение (201); ответы бота и оператора приходят в ленту
 * (GET …/events). Повторы отсекаются по id сообщения.
 */
export class ChatController {
  private p: Persisted;
  private notice: Notice | null = null;
  private blocked = false;
  private preparing = false;
  private active = false;
  private destroyed = false;
  /** Растёт при reset и смене диалога в другой вкладке: циклы старого диалога видят это и выходят. */
  private generation = 0;
  private outboxRunning = false;
  private pollRunning = false;
  /** pollLoop позвали, пока он заканчивался: запустить ещё раз. */
  private pollAgain = false;
  private pollCtrl: AbortController | null = null;
  /** История текущего диалога сверена со шлюзом за эту загрузку страницы. */
  private historySynced: boolean;
  private awaitTimer: ReturnType<typeof setTimeout> | undefined;
  private typingFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  /** До какого момента показывать «печатает» по событию typing шлюза. Только в памяти. */
  private typingUntil = 0;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** id сообщений шлюза, уже показанных или взятых в обработку. Пополняется синхронно — до хука. */
  private seen = new Set<string>();
  private readonly raw = new Map<string, RawIncoming>();
  /** Картинки неотправленных сообщений до загрузки на шлюз. Только в памяти: в localStorage не помещаются. */
  private readonly payloads = new Map<string, Blob>();
  /** Загруженные файлы: id → blob: URL. */
  private readonly files = new Map<string, Promise<string>>();
  private readonly listeners = new Set<(e: ControllerEvent) => void>();

  private hooks: Hooks;
  /** Без заданных хуков не отправлять и не показывать (fail-closed). Можно включить после загрузки. */
  private requireHooks: boolean;
  private context: Record<string, unknown> = {};
  texts: Texts;
  private readonly hookTimeoutMs: number;
  private readonly pollWaitSec: number;
  private readonly pollIntervalMs: number;
  private readonly backoff: number[];
  private readonly awaitMaxMs: number;
  private consentUrl: string | null;

  constructor(private readonly opts: ChatControllerOptions) {
    this.hooks = opts.hooks ?? {};
    this.requireHooks = opts.requireHooks ?? false;
    this.texts = { ...DEFAULT_TEXTS, ...opts.texts };
    this.hookTimeoutMs = opts.hookTimeoutMs ?? 5000;
    this.pollWaitSec = opts.pollWaitSec ?? 25;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.awaitMaxMs = opts.awaitMaxMs ?? 120_000;
    this.consentUrl = opts.consentUrl || null;
    this.p = opts.store.load() ?? this.fresh();
    this.historySynced = this.p.conversationId === null;
    this.rebuildSeen();
    this.scheduleAwaitExpiry();
    // Неотправленное до перезагрузки досылаем: client_msg_id тот же, дубля не будет.
    if (this.p.messages.some((m) => m.status === 'sending')) queueMicrotask(() => this.flushOutbox());
    // Ушли со страницы, не дождавшись ответа: дождёмся его и при закрытом окне — покажем счётчик.
    else if (this.isAwaiting()) queueMicrotask(() => this.pollLoop());
  }

  // ---------- состояние и подписка ----------

  get state(): ChatState {
    return {
      conversationId: this.p.conversationId,
      messages: this.p.messages,
      awaiting: this.showsTyping(),
      notice: this.notice,
      blocked: this.blocked,
      consentAccepted: !this.consentUrl || this.p.consentUrl === this.consentUrl,
      unread: this.p.unread ?? 0,
      preparing: this.preparing,
    };
  }

  /** Это проактивное правило уже показывали посетителю. */
  proactiveShown(id: string): boolean {
    return this.p.proactiveShown?.includes(id) ?? false;
  }

  /** Запомнить показ правила (до показа сообщения: пузырь мог закрыть посетитель). */
  markProactiveShown(id: string): void {
    if (this.proactiveShown(id)) return;
    this.p.proactiveShown = [...(this.p.proactiveShown ?? []), id];
    this.save();
  }

  /**
   * Показать приглашение в ленте как сообщение ассистента. В шлюз ничего не уходит, пока
   * посетитель не ответит; его ответ понесёт в context, на какое приглашение он отвечает.
   */
  addProactiveMessage(id: string, text: string, context: Record<string, string>): void {
    this.markProactiveShown(id);
    this.p.messages = [
      ...this.p.messages,
      { id: `pro-${id}-${Date.now()}`, sender: 'ai', text, createdAt: new Date().toISOString(), local: true },
    ];
    this.p.proactiveContext = context;
    this.save();
    this.changed();
  }

  get teaserDismissed(): boolean {
    return this.p.teaserDismissed === true;
  }

  dismissTeaser(): void {
    if (this.p.teaserDismissed) return;
    this.p.teaserDismissed = true;
    this.save();
    this.changed();
  }

  get autoOpened(): boolean {
    return this.p.autoOpened;
  }

  markAutoOpened(): void {
    this.p.autoOpened = true;
    this.save();
  }

  subscribe(fn: (e: ControllerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- настройки ----------

  setHooks(h: Hooks): void {
    this.hooks = { ...this.hooks, ...h };
    // Хук появился позже сообщений: показываем то, что ждало обработки.
    if (h.afterReceive) for (const id of [...this.raw.keys()]) void this.retryReceive(id);
  }

  /** Пауза перед повтором не меньше minRetryMs: Retry-After: 0 или дата в прошлом не дадут плотного цикла. */
  private atLeast(ms: number): number {
    return Math.max(this.opts.minRetryMs ?? 1000, ms);
  }

  setRequireHooks(on: boolean): void {
    this.requireHooks = on;
  }

  setTexts(t: Partial<Texts>): void {
    this.texts = { ...this.texts, ...t };
    this.changed();
  }

  setConsentUrl(url: string | null): void {
    this.consentUrl = url || null;
    this.changed();
  }

  /** Сведения о странице для ответов ассистента. null очищает. */
  setContext(ctx: Record<string, unknown> | null): void {
    this.context = ctx ? { ...this.context, ...ctx } : {};
  }

  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  /**
   * Чат открыт и вкладка видна — слушаем ленту и считаем всё прочитанным. Иначе лента идёт,
   * только пока ждём ответа на вопрос (не дольше awaitMaxMs), а пришедшее копится в unread.
   */
  setActive(on: boolean): void {
    if (this.destroyed || this.active === on) return;
    this.active = on;
    if (on) {
      this.markRead();
      this.pollLoop();
    } else if (!this.isAwaiting()) {
      this.stopPoll();
    }
  }

  markRead(): void {
    if (!this.p.unread) return;
    this.p.unread = 0;
    this.save();
    this.changed();
  }

  // ---------- действия посетителя ----------

  acceptConsent(): void {
    this.p.consentUrl = this.consentUrl;
    this.save();
    this.changed();
  }

  /**
   * Отправить сообщение: текст, картинку (см. prepareImage) или то и другое. false — сообщение
   * не принято (пустое, нет согласия, сбой хука); при сбое хука в notice — предложение повторить.
   */
  async send(input: string, attachment?: OutgoingAttachment): Promise<boolean> {
    const text = input.trim();
    if ((!text && !attachment) || text.length > MAX_TEXT_LENGTH || this.blocked || this.preparing) return false;
    if (!this.state.consentAccepted) return false;

    const gen = this.generation;
    this.preparing = true;
    this.notice = null;
    this.changed();

    let masked = '';
    let file: Blob | undefined;
    let thumb = attachment?.thumb;
    let stage = 'before_send_failed';
    try {
      if (text) {
        const hook = this.hooks.beforeSend;
        if (!hook && this.requireHooks) throw new Error('beforeSend не задан');
        masked = (await this.runHook(() => (hook ? hook(text, this.hookCtx()) : text))).trim();
        if (!masked) throw new Error('beforeSend вернул пустой текст');
      }
      if (attachment) {
        stage = 'before_attach_failed';
        const hook = this.hooks.beforeAttach;
        if (!hook && this.requireHooks) throw new Error('beforeAttach не задан');
        const blob = hook
          ? await withTimeout(
              Promise.resolve().then(() => hook(attachment.blob, { ...this.hookCtx(), name: attachment.name })),
              this.hookTimeoutMs,
            )
          : attachment.blob;
        if (!(blob instanceof Blob)) throw new Error('beforeAttach не пропустил вложение');
        file = blob.type ? blob : new Blob([blob], { type: 'image/jpeg' });
        // Хук изменил картинку (например, закрасил паспорт): превью в истории — с изменённой, а не с исходной.
        if (blob !== attachment.blob) thumb = await makeThumb(file).catch(() => undefined);
      }
    } catch (e) {
      // Fail-closed: непроверенное в API не уходит ни при каком сбое.
      this.preparing = false;
      if (gen !== this.generation) return false;
      this.notice = { kind: 'hook', text: this.texts.hookFailed, retryText: text };
      this.emitError(stage, errMessage(e));
      this.changed();
      return false;
    }
    this.preparing = false;
    if (gen !== this.generation || this.destroyed) return false;

    const msg: ChatMessage = {
      id: uuid(),
      sender: 'user',
      text,
      sentText: masked.slice(0, MAX_TEXT_LENGTH),
      status: 'sending',
      createdAt: new Date().toISOString(),
    };
    // Первый ответ после приглашения несёт его контекст: бот поймёт, о чём речь.
    if (this.p.proactiveContext) {
      msg.extraContext = this.p.proactiveContext;
      this.p.proactiveContext = undefined;
    }
    if (attachment && file) {
      msg.attachments = [{ name: attachment.name, mimeType: file.type, size: file.size, thumb }];
      this.payloads.set(msg.id, file);
    }
    this.p.messages = [...this.p.messages, msg];
    this.p.awaitingSince = Date.now();
    this.scheduleAwaitExpiry();
    this.save();
    this.emit({
      type: 'message',
      detail: {
        direction: 'out',
        sender: 'user',
        id: msg.id,
        text: msg.sentText!,
        attachments: msg.attachments?.map((a) => ({ name: a.name, mimeType: a.mimeType })),
      },
    });
    this.changed();
    this.flushOutbox();
    return true;
  }

  /**
   * Ответить на запрос оценки диалога. Одна оценка на запрос: после ответа карточка закрыта.
   * 409 already_rated (оценка уже есть, например из другой вкладки) считается успехом.
   */
  async rate(id: string, value: RatingValue): Promise<void> {
    const m = this.p.messages.find((x) => x.id === id);
    const req = m?.ratingRequest;
    const conv = this.p.conversationId;
    if (!m || !req || req.value || req.sending || !conv) return;
    const gen = this.generation;
    this.updateMessage(id, { ratingRequest: { ...req, value, sending: true } });
    this.changed();
    try {
      await this.opts.transport.feedback(conv, id, value);
    } catch (e) {
      const err = toApiError(e);
      if (gen !== this.generation) return;
      if (err.status !== 409) {
        this.updateMessage(id, { ratingRequest: { scale: req.scale } });
        this.notice = { kind: 'error', text: this.texts.rateFailed };
        this.emitError(err.code, err.message, err.status);
        this.changed();
        return;
      }
    }
    if (gen !== this.generation) return;
    this.updateMessage(id, { ratingRequest: { scale: req.scale, value } });
    this.save();
    this.emit({ type: 'rating', detail: { messageId: id, rating: value } });
    this.changed();
  }

  /** Файл сообщения как blob: URL (загружается один раз за сессию страницы). */
  loadFile(id: string): Promise<string> {
    let p = this.files.get(id);
    if (!p) {
      p = this.opts.transport.fetchFile(id).then((b) => URL.createObjectURL(b));
      p.catch(() => this.files.delete(id));
      this.files.set(id, p);
    }
    return p;
  }

  /** Повторить сообщение, которое не ушло. */
  retry(id: string): void {
    const m = this.p.messages.find((x) => x.id === id);
    if (!m || m.status !== 'failed' || m.final) return;
    this.updateMessage(id, { status: 'sending', error: undefined });
    this.p.awaitingSince = Date.now();
    this.scheduleAwaitExpiry();
    this.notice = null;
    this.save();
    this.changed();
    this.flushOutbox();
  }

  /** Повторно прогнать afterReceive для сообщения, которое не удалось показать. */
  async retryReceive(id: string): Promise<void> {
    let raw = this.raw.get(id);
    if (!raw) {
      // Исходник жил только в памяти (неочищенный текст в localStorage не пишем) — берём его у шлюза.
      const conv = this.p.conversationId;
      if (!conv) return;
      const gen = this.generation;
      try {
        const h = await this.opts.transport.history(conv, HISTORY_RETRY_LIMIT);
        const item = h.items.find((x) => x.id === id);
        if (!item || gen !== this.generation) return;
        raw = { message: item, actor: item.actor, text: incomingText(item) };
      } catch (e) {
        const err = toApiError(e);
        this.emitError(err.code, err.message, err.status);
        return;
      }
    }
    const shown = await this.processIncoming(raw.text, raw.message, raw.actor);
    if (shown === null) return;
    this.raw.delete(id);
    this.updateMessage(id, { text: shown, unprocessed: false });
    this.save();
    this.changed();
  }

  /** Показать посетителю ошибку интерфейса (например, вложение не подошло). */
  showError(text: string): void {
    this.notice = { kind: 'error', text };
    this.changed();
  }

  dismissNotice(): void {
    if (this.notice?.kind === 'config') return;
    this.notice = null;
    this.changed();
  }

  /**
   * Новый посетитель с чистого листа — например, пользователь вышел из аккаунта: лента и кэш очищаются,
   * visitor_token и сессия забываются, согласие на обработку ПД спросим снова. Следующее сообщение
   * откроет новую сессию и новый диалог; прежние диалоги с этого браузера больше не доступны.
   */
  reset(): void {
    this.opts.transport.forgetVisitor();
    this.dropFiles();
    this.payloads.clear();
    this.generation++;
    this.stopPoll();
    this.setTyping(0);
    const prev = this.p;
    this.p = this.fresh();
    this.p.autoOpened = prev.autoOpened;
    this.p.teaserDismissed = prev.teaserDismissed;
    this.p.proactiveShown = prev.proactiveShown;
    this.historySynced = true;
    this.notice = null;
    this.raw.clear();
    this.rebuildSeen();
    this.scheduleAwaitExpiry();
    this.save();
    this.changed();
  }

  /** Подтянуть состояние, которое записала другая вкладка. */
  reloadFromStorage(): void {
    const d = this.opts.store.load();
    if (!d) return;
    const convChanged = d.conversationId !== this.p.conversationId;
    // Своё неотправленное, которого другая вкладка ещё не видела, не теряем: она перезаписала всё состояние.
    const known = new Set(d.messages.map((m) => m.id));
    const mine = this.p.messages.filter((m) => m.sender === 'user' && m.status !== 'sent' && !known.has(m.id));
    if (mine.length) d.messages = [...d.messages, ...mine].sort((a, b) => time(a.createdAt) - time(b.createdAt));
    this.p = d;
    this.rebuildSeen();
    if (convChanged) {
      this.generation++;
      this.stopPoll();
      this.notice = null;
      // Историю нового диалога сверила вкладка, которая его создала.
      this.historySynced = true;
    }
    this.scheduleAwaitExpiry();
    if (mine.length) this.save();
    this.changed();
    if (this.active) this.pollLoop();
    // Отправка, начатая в закрытой вкладке: досылаем (тот же client_msg_id — дубля не будет).
    if (this.p.messages.some((m) => m.status === 'sending')) this.flushOutbox();
  }

  destroy(): void {
    this.dropFiles();
    this.destroyed = true;
    this.generation++;
    this.stopPoll();
    clearTimeout(this.awaitTimer);
    clearTimeout(this.typingFallbackTimer);
    clearTimeout(this.typingTimer);
    this.listeners.clear();
  }

  // ---------- отправка ----------

  private async flushOutbox(): Promise<void> {
    if (this.outboxRunning || this.blocked || this.destroyed) return;
    this.outboxRunning = true;
    const gen = this.generation;
    let attempt = 0;
    /** Сколько раз подряд диалог оказывался закрыт (409) или не найден (404). */
    let reopened = 0;
    try {
      while (gen === this.generation) {
        const m = this.p.messages.find((x) => x.status === 'sending');
        if (!m) break;
        let stage: 'message' | 'upload' = 'message';
        try {
          const conv = await this.ensureConversation(gen);
          if (gen !== this.generation) return;

          let fileId = m.attachments?.[0]?.id;
          if (m.attachments?.length && !fileId) {
            const blob = this.payloads.get(m.id);
            if (!blob) {
              // Картинка жила только в памяти и пропала при перезагрузке страницы, до загрузки на шлюз.
              this.failMessage(m.id, this.texts.attachmentLost, true);
              continue;
            }
            stage = 'upload';
            // Имя файла посетителя («Паспорт_Иванов.jpg») маскирование не проходит и попало бы в адрес
            // запроса и к боту — отправляем нейтральное. Своё имя посетитель видит в ленте.
            const up = await this.opts.transport.upload(blob, neutralName(blob.type));
            if (gen !== this.generation) return;
            fileId = up.file_id;
            // file_id сохраняем: при повторе (и после перезагрузки) картинку заново не грузим.
            this.updateMessage(m.id, { attachments: [{ ...m.attachments[0], id: fileId }] });
            this.payloads.delete(m.id);
            this.save();
            stage = 'message';
          }

          const parts: Part[] = [];
          const text = m.sentText ?? m.text;
          if (text) parts.push({ type: 'text', text });
          if (fileId) parts.push({ type: 'file', file_id: fileId });
          const body: SendBody = { client_msg_id: m.id, parts };
          const context = gatewayContext(this.context, m.extraContext);
          if (context) body.context = context;

          const ev = await this.opts.transport.sendMessage(conv, body);
          if (gen !== this.generation) return;
          attempt = 0;
          reopened = 0;
          this.clearTransientNotice();
          const serverId = (ev?.data as Partial<ServerMessage> | null)?.id;
          if (typeof serverId === 'string') this.seen.add(serverId);
          const patch: Partial<ChatMessage> = { status: 'sent' };
          if (typeof serverId === 'string') patch.serverId = serverId;
          // Время шлюза, а не часов посетителя: так своё сообщение встаёт по порядку среди ответов.
          if (typeof ev?.ts === 'string' && ev.ts) patch.createdAt = ev.ts;
          this.updateMessage(m.id, patch);
          this.save();
          this.changed();
          // Ответ придёт в ленту.
          this.pollLoop();
        } catch (e) {
          if (gen !== this.generation) return;
          const err = toApiError(e);
          if (isConfigError(err)) {
            this.block(err);
            this.failMessage(m.id, this.texts.configError, true);
            break;
          } else if ((err.status === 409 && err.code === 'conversation_closed') || (err.status === 404 && stage === 'message')) {
            // Диалог закрыт или больше не наш (шлюз выдал нового посетителя): новый диалог и повтор.
            if (++reopened > 2) {
              this.failMessage(m.id, this.texts.sendFailed);
              this.emitError(err.code, err.message, err.status);
              continue;
            }
            this.dropConversation();
          } else if (err.status === 429) {
            this.notice = { kind: 'rate-limit', text: this.texts.rateLimited };
            this.changed();
            await sleep(this.atLeast(err.retryAfterMs ?? 5000));
          } else if (err.retryable) {
            attempt++;
            if (attempt > this.backoff.length) {
              this.failAllSending(this.texts.sendFailed);
              this.notice = { kind: 'error', text: this.texts.unavailable };
              this.emitError(err.code, err.message, err.status);
              this.changed();
              break;
            }
            this.notice = { kind: 'retrying', text: this.texts.retrying };
            this.changed();
            await sleep(this.atLeast(err.retryAfterMs ?? jitter(this.backoff[attempt - 1])));
          } else {
            // 422, 413, 415 и прочие 4xx: повтор даст то же. Посетителю — понятный текст,
            // технический detail шлюза — только в событие error.
            const attach = stage === 'upload' || err.status === 413 || err.status === 415;
            this.failMessage(m.id, attach ? this.texts.attachRejected : this.texts.sendRejected, true);
            this.emitError(err.code, err.message, err.status);
          }
        }
      }
    } finally {
      this.outboxRunning = false;
      if (gen === this.generation) {
        this.save();
        this.changed();
      } else if (!this.destroyed && !this.blocked && this.p.messages.some((x) => x.status === 'sending')) {
        // Пока старый цикл ждал ответа, был reset или другая вкладка сменила диалог, а новое уже ждёт отправки.
        queueMicrotask(() => this.flushOutbox());
      }
    }
  }

  /** id текущего диалога; нет — создать (POST /v1/conversations). */
  private async ensureConversation(gen: number): Promise<string> {
    if (this.p.conversationId) return this.p.conversationId;
    const c = await this.opts.transport.createConversation();
    if (gen !== this.generation) return c.id;
    this.p.conversationId = c.id;
    this.p.cursor = c.cursor;
    this.historySynced = true;
    this.save();
    return c.id;
  }

  /** Забыть диалог шлюза (закрыт или не наш). История на экране остаётся, следующее сообщение откроет новый. */
  private dropConversation(): void {
    this.p.conversationId = null;
    this.p.cursor = null;
    this.historySynced = true;
    this.stopPoll();
    this.save();
  }

  // ---------- лента ----------

  private shouldPoll(): boolean {
    return this.p.conversationId !== null && (this.active || this.isAwaiting()) && !this.blocked && !this.destroyed;
  }

  private async pollLoop(): Promise<void> {
    if (this.destroyed) return;
    if (this.pollRunning) {
      this.pollAgain = true;
      return;
    }
    this.pollRunning = true;
    this.pollAgain = false;
    const gen = this.generation;
    const conv = this.p.conversationId;
    let attempt = 0;
    let expired = 0;
    try {
      while (gen === this.generation && conv !== null && this.p.conversationId === conv && this.shouldPoll()) {
        const ctrl = new AbortController();
        this.pollCtrl = ctrl;
        const started = Date.now();
        try {
          if (!this.historySynced) {
            await this.syncHistory(conv, gen);
            if (gen !== this.generation || this.p.conversationId !== conv) return;
          }
          const r = await this.opts.transport.events(conv, this.p.cursor, this.pollWaitSec, ctrl.signal);
          if (gen !== this.generation || this.p.conversationId !== conv) return;
          if (attempt > 0) this.clearTransientNotice();
          attempt = 0;
          await this.applyEvents(r.events, gen);
          if (gen !== this.generation || this.p.conversationId !== conv) return;
          this.p.cursor = r.cursor;
          this.save();
          // Пришли события — сразу за следующими. Шлюз без долгого опроса — не чаще раза в pollIntervalMs.
          if (!r.events.length || this.pollWaitSec === 0) {
            const rest = this.pollIntervalMs - (Date.now() - started);
            if (rest > 0) await sleep(rest, ctrl.signal);
          }
        } catch (e) {
          if (isAbort(e) || gen !== this.generation) return;
          const err = toApiError(e);
          if (isConfigError(err)) {
            this.block(err);
            return;
          }
          if (err.status === 410 && expired++ < 2) {
            // Курсор старше хранимой ленты: перечитать историю, курсор — из объекта диалога.
            this.p.cursor = null;
            this.historySynced = false;
            this.save();
            continue;
          }
          if (err.status === 404) {
            // Диалог не наш (шлюз выдал нового посетителя): следующее сообщение откроет новый.
            this.dropConversation();
            return;
          }
          if (err.status === 422 || err.status === 410) {
            this.emitError(err.code, err.message, err.status);
            return;
          }
          if (err.status === 429) {
            await sleep(this.atLeast(err.retryAfterMs ?? 10_000), ctrl.signal);
            continue;
          }
          attempt++;
          // Первые сбои опроса посетителю не показываем: он ничего не ждёт.
          if (attempt >= 3 && this.isAwaiting()) {
            this.notice = { kind: 'retrying', text: this.texts.retrying };
            this.changed();
          }
          await sleep(this.atLeast(err.retryAfterMs ?? jitter(this.backoff[Math.min(attempt, this.backoff.length) - 1])), ctrl.signal);
        } finally {
          if (this.pollCtrl === ctrl) this.pollCtrl = null;
        }
      }
    } catch (e) {
      if (!isAbort(e)) throw e;
    } finally {
      this.pollRunning = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        queueMicrotask(() => this.pollLoop());
      }
    }
  }

  private stopPoll(): void {
    this.pollCtrl?.abort();
    this.pollCtrl = null;
  }

  /**
   * Сверить кэш с историей шлюза: последние HISTORY_LIMIT сообщений в текущем состоянии.
   * Нет курсора — берём его из объекта диалога (до истории, чтобы между ними ничего не потерять).
   */
  private async syncHistory(conv: string, gen: number): Promise<void> {
    if (this.p.cursor === null) {
      const c = await this.opts.transport.getConversation(conv);
      if (gen !== this.generation || this.p.conversationId !== conv) return;
      this.p.cursor = c.cursor;
    }
    const h = await this.opts.transport.history(conv, HISTORY_LIMIT);
    if (gen !== this.generation || this.p.conversationId !== conv) return;
    let added = false;
    for (const item of [...h.items].reverse()) {
      added = (await this.upsert(item, item.actor, item.ts, gen)) || added;
      if (gen !== this.generation) return;
    }
    // Пришедшее из истории встаёт по времени, а не в конец.
    if (added) this.p.messages = [...this.p.messages].sort((a, b) => time(a.createdAt) - time(b.createdAt));
    this.historySynced = true;
    this.save();
    this.changed();
  }

  private async applyEvents(events: ServerEvent[], gen: number): Promise<void> {
    for (const ev of events) {
      if (ev.type === 'typing') {
        this.applyTyping(ev);
        continue;
      }
      if (ev.type === 'read') {
        this.applyRead(ev);
        continue;
      }
      if (ev.type !== 'message.created' && ev.type !== 'message.updated') continue;
      const data = ev.data as ServerMessage | null;
      if (!data || typeof data.id !== 'string') continue;
      await this.upsert(data, ev.actor, ev.ts, gen);
      if (gen !== this.generation) return;
    }
  }

  /** «Печатает» ассистента или оператора: срок считаем от получения, а не по ts (часы посетителя врут). */
  private applyTyping(ev: ServerEvent): void {
    if (ev.actor?.role === 'visitor') return;
    const d = (ev.data ?? {}) as { state?: unknown; expires_in?: unknown };
    if (d.state === 'start') {
      const sec = typeof d.expires_in === 'number' && d.expires_in > 0 ? Math.min(d.expires_in, 300) : 30;
      this.setTyping(Date.now() + sec * 1000);
    } else if (d.state === 'stop') {
      this.setTyping(0);
    }
  }

  private setTyping(until: number): void {
    clearTimeout(this.typingTimer);
    const was = Date.now() < this.typingUntil;
    this.typingUntil = until;
    const rest = until - Date.now();
    if (rest > 0) this.typingTimer = setTimeout(() => this.changed(), rest + 50);
    if (was !== rest > 0) this.changed();
  }

  /** «Прочитано» ассистентом или оператором: все свои сообщения до up_to включительно. */
  private applyRead(ev: ServerEvent): void {
    if (ev.actor?.role === 'visitor') return;
    const upTo = (ev.data as { up_to?: unknown } | null)?.up_to;
    if (typeof upTo !== 'string') return;
    const last = this.p.messages.findIndex((m) => m.sender === 'user' && m.serverId === upTo);
    if (last < 0) return;
    let changed = false;
    this.p.messages = this.p.messages.map((m, i) => {
      if (i > last || m.sender !== 'user' || m.read || m.status !== 'sent') return m;
      changed = true;
      return { ...m, read: true };
    });
    if (!changed) return;
    this.save();
    this.changed();
  }

  /**
   * Сообщение из ленты или истории: новое добавить, известное — обновить (оценка).
   * true — добавлено новое.
   */
  private async upsert(sm: ServerMessage, actor: Actor | undefined, ts: string, gen: number): Promise<boolean> {
    const role = actor?.role;
    const parts = Array.isArray(sm.parts) ? sm.parts : [];

    if (role === 'visitor') {
      // Своё сообщение: из этой вкладки (по client_msg_id) или из другой вкладки.
      this.seen.add(sm.id);
      const own = this.p.messages.find((m) => m.sender === 'user' && (m.serverId === sm.id || m.id === sm.client_msg_id));
      if (own) {
        if (own.serverId !== sm.id || own.status !== 'sent' || (ts && own.createdAt !== ts)) {
          this.updateMessage(own.id, { serverId: sm.id, status: 'sent', error: undefined, final: undefined, createdAt: ts || own.createdAt });
          this.save();
          this.changed();
        }
        return false;
      }
      const text = parts.filter(isText).map((p) => p.text).join('\n');
      this.p.messages = [
        ...this.p.messages,
        {
          id: sm.client_msg_id || sm.id,
          serverId: sm.id,
          sender: 'user',
          text,
          createdAt: ts,
          status: 'sent',
          attachments: attachmentsOf(parts),
        },
      ];
      this.save();
      this.changed();
      return true;
    }

    const rating = parts.find(isRatingRequest);
    if (this.seen.has(sm.id)) {
      // Уже показано: обновляется только оценка (message.updated с rated).
      const m = this.p.messages.find((x) => x.id === sm.id);
      if (m?.ratingRequest && rating?.rated && !m.ratingRequest.value && !m.ratingRequest.sending) {
        this.updateMessage(sm.id, { ratingRequest: { scale: m.ratingRequest.scale, value: rating.rated } });
        this.save();
        this.changed();
      }
      return false;
    }
    this.seen.add(sm.id);

    const system = parts.find(isSystem);
    const known = parts.every((p) => KNOWN_PARTS.has(p.type));
    let text: string | null;
    if (system && known) {
      // Служебная фраза шлюза — его же текст, не ответ бота: хук маскирования не нужен.
      text = String(system.text ?? '');
    } else {
      const raw = incomingText(sm);
      text = await this.processIncoming(raw, sm, actor);
      if (text === null) this.raw.set(sm.id, { message: sm, actor: actor ?? { role: 'bot' }, text: raw });
    }
    if (gen !== this.generation) return false;

    const msg: ChatMessage = {
      id: sm.id,
      sender: system ? 'system' : role === 'operator' ? 'operator' : 'ai',
      text: text ?? '',
      createdAt: ts,
      unprocessed: text === null || undefined,
    };
    if (actor?.name) msg.name = actor.name;
    if (system) msg.systemCode = String(system.code ?? '');
    const files = known ? attachmentsOf(parts) : undefined;
    if (files) msg.attachments = files;
    if (rating && (rating.scale === 'like_dislike' || rating.scale === 'stars')) {
      msg.ratingRequest = { scale: rating.scale };
      if (rating.rated) msg.ratingRequest.value = rating.rated;
    }
    this.p.messages = [...this.p.messages, msg];
    // Ответил ассистент, оператор или шлюз — «печатает…» больше не нужно.
    this.p.awaitingSince = null;
    this.setTyping(0);
    if (!this.active) this.p.unread = (this.p.unread ?? 0) + 1;
    if (text !== null) this.emit({ type: 'message', detail: { direction: 'in', sender: msg.sender, id: sm.id, text } });
    this.save();
    this.changed();
    return true;
  }

  /** afterReceive с таймаутом. null — хук упал: исходный текст не показываем. */
  private async processIncoming(text: string, sm: ServerMessage, actor: Actor | undefined): Promise<string | null> {
    const hook = this.hooks.afterReceive;
    // Пустой текст (пришёл только файл) хуку не отдаём.
    if (!text) return text;
    if (!hook) return this.requireHooks ? null : text;
    try {
      const a = actor ?? { role: 'bot' };
      const sender = a.role === 'operator' ? 'operator' : 'ai';
      return await this.runHook(() => hook(text, { ...this.hookCtx(), sender, messageId: sm.id, message: sm, actor: a }));
    } catch (e) {
      this.emitError('after_receive_failed', errMessage(e));
      return null;
    }
  }

  // ---------- служебное ----------

  private async runHook(fn: () => string | Promise<string>): Promise<string> {
    const r = await withTimeout(Promise.resolve().then(fn), this.hookTimeoutMs);
    if (typeof r !== 'string') throw new Error('хук вернул не строку');
    return r;
  }

  private hookCtx() {
    const id = this.p.conversationId;
    return { conversationId: id, chatId: id ?? '', context: this.getContext() };
  }

  private dropFiles(): void {
    for (const p of this.files.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
    this.files.clear();
  }

  private rebuildSeen(): void {
    this.seen = new Set();
    for (const m of this.p.messages) {
      if (m.local) continue;
      if (m.sender === 'user') {
        if (m.serverId) this.seen.add(m.serverId);
      } else {
        this.seen.add(m.id);
      }
    }
  }

  private fresh(): Persisted {
    return {
      v: 2,
      conversationId: null,
      cursor: null,
      messages: [],
      awaitingSince: null,
      consentUrl: null,
      autoOpened: false,
    };
  }

  private block(err: ApiError): void {
    this.blocked = true;
    this.p.awaitingSince = null;
    this.notice = { kind: 'config', text: this.texts.configError };
    this.emitError(err.code, err.message, err.status);
    this.changed();
  }

  private failMessage(id: string, error: string, final = false): void {
    this.updateMessage(id, { status: 'failed', error, final });
    if (!this.p.messages.some((m) => m.status === 'sending')) this.p.awaitingSince = null;
    this.save();
    this.changed();
  }

  private failAllSending(error: string): void {
    this.p.messages = this.p.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'failed', error } : m));
    this.p.awaitingSince = null;
    this.save();
  }

  private updateMessage(id: string, patch: Partial<ChatMessage>): void {
    this.p.messages = this.p.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
  }

  private clearTransientNotice(): void {
    if (this.notice && (this.notice.kind === 'retrying' || this.notice.kind === 'rate-limit')) {
      this.notice = null;
      this.changed();
    }
  }

  /**
   * «Печатает…»: по событию typing шлюза, а сразу после отправки — до TYPING_FALLBACK_MS, пока шлюз не сказал своё.
   * Дальше индикатор сам не висит: если ассистент молчит, шлюз пришлёт системную фразу.
   */
  private showsTyping(): boolean {
    if (Date.now() < this.typingUntil) return true;
    return this.p.awaitingSince !== null && Date.now() - this.p.awaitingSince < Math.min(this.awaitMaxMs, TYPING_FALLBACK_MS);
  }

  private isAwaiting(): boolean {
    return this.p.awaitingSince !== null && Date.now() - this.p.awaitingSince < this.awaitMaxMs;
  }

  private scheduleAwaitExpiry(): void {
    clearTimeout(this.awaitTimer);
    clearTimeout(this.typingFallbackTimer);
    if (this.p.awaitingSince === null) return;
    const rest = this.p.awaitingSince + this.awaitMaxMs - Date.now();
    if (rest > 0) this.awaitTimer = setTimeout(() => this.changed(), rest + 50);
    clearTimeout(this.typingFallbackTimer);
    const typingRest = this.p.awaitingSince + TYPING_FALLBACK_MS - Date.now();
    if (typingRest > 0 && typingRest < rest) this.typingFallbackTimer = setTimeout(() => this.changed(), typingRest + 50);
  }

  private save(): void {
    if (!this.destroyed) this.opts.store.save(this.p);
  }

  private emitError(code: string, message: string, status?: number): void {
    this.emit({ type: 'error', detail: { code, message, status } });
  }

  private changed(): void {
    this.emit({ type: 'change' });
  }

  private emit(e: ControllerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error('[avai-chat] listener error', err);
      }
    }
  }
}

const KNOWN_PARTS = new Set(['text', 'file', 'system', 'rating_request']);

function isText(p: Part): p is { type: 'text'; text: string } {
  return p.type === 'text' && typeof (p as { text?: unknown }).text === 'string';
}

function isSystem(p: Part): p is { type: 'system'; code: string; text: string } {
  return p.type === 'system';
}

function isRatingRequest(p: Part): p is { type: 'rating_request'; scale: 'like_dislike' | 'stars'; rated?: RatingValue | null } {
  return p.type === 'rating_request';
}

/** Текст входящего для показа и хука: части text или fallback_text, если есть часть незнакомого типа. */
function incomingText(sm: ServerMessage): string {
  const parts = Array.isArray(sm.parts) ? sm.parts : [];
  return parts.every((p) => KNOWN_PARTS.has(p.type))
    ? parts.filter(isText).map((p) => p.text).join('\n')
    : String(sm.fallback_text ?? '');
}

/** Шлюз принимает context: до 20 пар, значения — строки до 500 символов. */
export const CONTEXT_MAX_KEYS = 20;
export const CONTEXT_MAX_VALUE = 500;

/** Контекст под контракт шлюза: числа и флаги — строкой, объекты — JSON, длинное обрезаем, лишние ключи отбрасываем. */
export function gatewayContext(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  // Контекст сообщения (ответ на приглашение) важнее общего — его ключи первыми.
  for (const [k, v] of [...Object.entries(extra ?? {}), ...Object.entries(base)]) {
    if (k in out || v === null || v === undefined) continue;
    if (Object.keys(out).length >= CONTEXT_MAX_KEYS) break;
    let s: string;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
    else {
      try {
        s = JSON.stringify(v) ?? '';
      } catch {
        continue;
      }
    }
    out[k] = s.slice(0, CONTEXT_MAX_VALUE);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Имя картинки для шлюза без данных посетителя: image.jpg, image.png, image.gif. */
export function neutralName(mime: string): string {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg';
  return `image.${ext}`;
}

function attachmentsOf(parts: Part[]): ChatAttachment[] | undefined {
  const files = parts.filter((p) => p.type === 'file' && typeof (p as { file_id?: unknown }).file_id === 'string') as Array<{
    file_id: string;
    name?: string;
    mime_type?: string;
    size?: number;
  }>;
  if (!files.length) return undefined;
  return files.map((f) => ({
    id: f.file_id,
    name: String(f.name ?? 'файл'),
    mimeType: String(f.mime_type ?? ''),
    size: typeof f.size === 'number' ? f.size : undefined,
  }));
}

/** 401 после повторной сессии, 403, сессию не открыть — настройка: отправка заблокирована. */
function isConfigError(err: ApiError): boolean {
  return err.fatal || err.status === 401 || err.status === 403;
}

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, 'network', errMessage(e));
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
