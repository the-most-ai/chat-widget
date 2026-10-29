// ---------- протокол v1.0 (ответы шлюза) ----------

/** Часть сообщения. Незнакомый type показываем как fallback_text всего сообщения. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'file'; file_id: string; name?: string; mime_type?: string; size?: number; url?: string }
  | { type: 'system'; code: string; text: string }
  | { type: 'rating_request'; scale: RatingScale; rated?: RatingValue | null }
  | { type: string; [k: string]: unknown };

export type ActorRole = 'visitor' | 'bot' | 'operator' | 'system';

export interface Actor {
  role: ActorRole | string;
  name?: string | null;
}

/** data события message.created / message.updated: текущее состояние сообщения. */
export interface ServerMessage {
  id: string;
  client_msg_id?: string | null;
  parts: Part[];
  fallback_text?: string;
}

/** Сообщение из истории (GET …/messages): data события плюс actor, ts, cursor. */
export interface HistoryMessage extends ServerMessage {
  actor: Actor;
  ts: string;
  cursor?: string;
}

/** Событие ленты диалога. Неизвестный type пропускаем. */
export interface ServerEvent {
  cursor: string;
  id: string;
  type: 'message.created' | 'message.updated' | 'conversation.updated' | 'typing' | 'read' | string;
  conversation_id: string;
  ts: string;
  actor: Actor;
  data: unknown;
}

export interface Conversation {
  id: string;
  status: 'open' | 'closed' | string;
  owner?: string;
  handoff_state?: string;
  operator?: { name?: string } | null;
  handoff_available?: boolean;
  created_at?: string;
  /** Текущая позиция ленты диалога: с неё начинается опрос. */
  cursor: string;
}

export interface EventsResponse {
  events: ServerEvent[];
  cursor: string;
}

export interface HistoryResponse {
  items: HistoryMessage[];
  next: string | null;
}

export interface UploadResponse {
  file_id: string;
  name?: string;
  mime_type?: string;
  size?: number;
}

export type RatingScale = 'like_dislike' | 'stars';
/** Ответ посетителя на запрос оценки. */
export type RatingValue = { liked: boolean } | { stars: number };

// ---------- модель виджета ----------

/** Вложение в истории виджета. */
export interface ChatAttachment {
  /** file_id шлюза. У своего вложения появляется после загрузки (POST /v1/uploads). */
  id?: string;
  name: string;
  mimeType: string;
  size?: number;
  /** Превью своей картинки посетителя (data: URL, маленький JPEG) — показываем без запроса к шлюзу. */
  thumb?: string;
}

/** Подготовленная к отправке картинка (см. prepareImage). */
export interface OutgoingAttachment {
  blob: Blob;
  name: string;
  /** Превью для истории, data: URL. */
  thumb?: string;
}

/** Сообщение в истории виджета. */
export interface ChatMessage {
  /** id сообщения шлюза; у своих — client_msg_id; у созданных в браузере — локальный. */
  id: string;
  /** Свои сообщения: id, который им дал шлюз. По нему отсекаем их же из ленты и истории. */
  serverId?: string;
  sender: 'user' | 'ai' | 'operator' | 'system';
  /** actor.name: имя бота или оператора. */
  name?: string;
  /** То, что видит посетитель: введённый текст или ответ после afterReceive. */
  text: string;
  createdAt: string;
  /** Для исходящих: состояние доставки. */
  status?: 'sending' | 'sent' | 'failed';
  /** Для исходящих: ассистент или оператор прочитал (событие read). */
  read?: boolean;
  /** Для исходящих: текст после beforeSend, именно он уходит в шлюз при повторе. */
  sentText?: string;
  /** Пояснение к failed. */
  error?: string;
  /** failed без кнопки повтора: шлюз отклонил сообщение (422), повтор даст то же. */
  final?: boolean;
  /** Входящее, которое afterReceive не смог обработать: показываем заглушку. */
  unprocessed?: boolean;
  attachments?: ChatAttachment[];
  /** Служебное сообщение шлюза (часть system): код, например bot_unavailable. */
  systemCode?: string;
  /** Сообщение — запрос оценки диалога; value — что ответил посетитель. */
  ratingRequest?: { scale: RatingScale; value?: RatingValue; sending?: boolean };
  /** Сообщение создано в браузере (проактивное приглашение): на сервере его нет. */
  local?: boolean;
  /** Добавка к context именно этого сообщения (например, на какое приглашение посетитель ответил). */
  extraContext?: Record<string, string>;
}

export interface ChatRatingEvent {
  messageId: string;
  rating: RatingValue;
}

export interface HookContext {
  /** id диалога на шлюзе; null — диалог ещё не создан (первое сообщение). */
  conversationId: string | null;
  /** @deprecated то же, что conversationId ('' до создания диалога). */
  chatId: string;
  context: Record<string, unknown>;
}

export interface ReceiveContext extends HookContext {
  sender: 'ai' | 'operator';
  messageId: string;
  /** Сообщение целиком, как пришло от шлюза (v1). */
  message: ServerMessage;
  actor: Actor;
}

export type BeforeSendHook = (text: string, ctx: HookContext) => string | Promise<string>;
export type AfterReceiveHook = (text: string, ctx: ReceiveContext) => string | Promise<string>;
/** Проверка вложения перед отправкой: вернуть Blob (тот же или изменённый) или null — не отправлять. */
export type BeforeAttachHook = (file: Blob, ctx: HookContext & { name: string }) => Blob | null | Promise<Blob | null>;

export interface Hooks {
  beforeSend?: BeforeSendHook;
  afterReceive?: AfterReceiveHook;
  beforeAttach?: BeforeAttachHook;
}

/** Состояние, которое отображает интерфейс. */
export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  /** Ждём ответа ассистента или шлюз прислал typing: показываем «печатает…». */
  awaiting: boolean;
  /** Баннер над полем ввода: временная недоступность, лимит, ошибка настройки. */
  notice: Notice | null;
  /** Ошибка настройки (401/403): отправка заблокирована до перезагрузки. */
  blocked: boolean;
  consentAccepted: boolean;
  /** Идёт обработка beforeSend. */
  preparing: boolean;
  /** Входящих, пришедших при закрытом окне или скрытой вкладке. */
  unread: number;
}

export interface Notice {
  kind: 'retrying' | 'rate-limit' | 'config' | 'hook' | 'error';
  text: string;
  /** Для kind=hook: текст, который посетитель может отправить повторно. */
  retryText?: string;
}

export interface ChatErrorEvent {
  code: string;
  message: string;
  status?: number;
}

export interface ChatMessageEvent {
  direction: 'in' | 'out';
  sender: ChatMessage['sender'];
  id: string;
  /** Для исходящих — текст после beforeSend (то, что ушло в шлюз). */
  text: string;
  /** Имена и типы вложений, без содержимого. */
  attachments?: Array<{ name: string; mimeType: string }>;
}
