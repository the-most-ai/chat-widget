import type { VisitorTokenStore } from './transport';
import type { ChatMessage } from './types';

/**
 * То, что лежит в localStorage. Источник истины — шлюз: здесь кэш для мгновенного показа
 * (id текущего диалога, курсор ленты, последние сообщения) и настройки посетителя.
 */
export interface Persisted {
  v: 2;
  /** Текущий диалог на шлюзе; null — ещё не создан (создаётся первым сообщением). */
  conversationId: string | null;
  cursor: string | null;
  messages: ChatMessage[];
  /** Время отправки последнего вопроса, на который ещё нет ответа ассистента. */
  awaitingSince: number | null;
  /** Адрес согласия, которое посетитель принял. Сменится адрес — спросим снова. */
  consentUrl: string | null;
  autoOpened: boolean;
  /** Пришло, пока окно было закрыто или вкладка скрыта. */
  unread?: number;
  /** Посетитель закрыл подсказку у лаунчера — больше не показываем. */
  teaserDismissed?: boolean;
  /** id проактивных правил, которые этому посетителю уже показывали (показ — один раз). */
  proactiveShown?: string[];
  /** Контекст показанного приглашения: уйдёт с ближайшим сообщением посетителя. */
  proactiveContext?: Record<string, string>;
}

/** Сколько сообщений держим в кэше: старые отбрасываем, чтобы не упереться в квоту localStorage. */
export const MAX_STORED_MESSAGES = 200;
/** Сколько сообщений оставляем, если полная лента не влезла в квоту. */
const QUOTA_FALLBACK_MESSAGES = 30;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class Store {
  readonly key: string;
  readonly visitorKey: string;

  constructor(
    tenant: string,
    private readonly storage: StorageLike | null = safeLocalStorage(),
  ) {
    this.key = `avai-chat:v2:${tenant}`;
    this.visitorKey = `avai-chat:${tenant}:visitor`;
  }

  load(): Persisted | null {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return null;
      const d = JSON.parse(raw) as Persisted;
      if (d?.v !== 2 || !Array.isArray(d.messages)) return null;
      return d;
    } catch {
      return null;
    }
  }

  save(d: Persisted): void {
    // Свои сообщения — в том виде, в каком ушли в шлюз (после beforeSend): неочищенный ввод
    // посетителя в браузере не оседает. На экране он остаётся до перезагрузки страницы.
    const messages = d.messages.slice(-MAX_STORED_MESSAGES).map((m) =>
      m.sender === 'user' && m.sentText !== undefined && m.text !== m.sentText ? { ...m, text: m.sentText } : m,
    );
    // Упёрлись в квоту — сначала без превью картинок, потом только хвост ленты: id диалога и курсор важнее истории.
    const attempts = [messages, messages.map(withoutThumbs), messages.slice(-QUOTA_FALLBACK_MESSAGES).map(withoutThumbs)];
    for (const list of attempts) {
      try {
        this.storage?.setItem(this.key, JSON.stringify({ ...d, messages: list }));
        return;
      } catch {
        // Квота или приватный режим: пробуем короче, в крайнем случае виджет работает без сохранения.
      }
    }
  }

  /** visitor_token посетителя: по нему шлюз открывает сессию и показывает его диалоги. */
  readonly visitor: VisitorTokenStore = {
    get: () => {
      try {
        return this.storage?.getItem(this.visitorKey) || this.visitorMem;
      } catch {
        return this.visitorMem;
      }
    },
    set: (token) => {
      // В памяти — на случай, если localStorage недоступен: тогда посетитель живёт до перезагрузки страницы.
      this.visitorMem = token;
      try {
        this.storage?.setItem(this.visitorKey, token);
      } catch {
        // Квота или приватный режим.
      }
    },
    clear: () => {
      this.visitorMem = null;
      try {
        this.storage?.removeItem(this.visitorKey);
      } catch {
        // Приватный режим.
      }
    },
  };

  private visitorMem: string | null = null;
}

function withoutThumbs(m: ChatMessage): ChatMessage {
  return m.attachments?.some((a) => a.thumb) ? { ...m, attachments: m.attachments.map(({ thumb: _t, ...a }) => a) } : m;
}

function safeLocalStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__avai_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
