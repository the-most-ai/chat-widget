import type { Texts } from './core/texts';
import type { Hooks } from './core/types';
import { normalizeRules, type ProactiveRule } from './ui/proactive';

export interface WidgetConfig {
  /** Адрес API с версией. По умолчанию — origin файла виджета + /v1. */
  api: string;
  tenant: string;
  title?: string;
  operatorName?: string;
  greeting?: string;
  consentUrl?: string;
  /** Открыть чат через N секунд после загрузки, один раз. */
  autoOpen?: number;
  position: 'right' | 'left';
  /** wait долгого опроса, с; 0 — обычный опрос раз в 3 с. */
  pollWait: number;
  /** Не отправлять и не показывать сообщения, пока не заданы оба хука маскирования. */
  requireHooks: boolean;
  /** Подпись «Работает на AvangardAI»; false — скрыть. */
  branding: boolean;
  /** Вложения (картинки) от посетителя: скрепка, вставка, перетаскивание. По умолчанию включены. */
  attachments: boolean;
  /** Готовые вопросы кнопками до первого сообщения посетителя. */
  quickReplies?: string[];
  /** Подсказка-пузырь у закрытого лаунчера, показывается через 3 с, пока посетитель её не закроет. */
  teaser?: string;
  /** URL аватаров ассистента и оператора (хост картинки должен быть разрешён в img-src CSP). */
  aiAvatar?: string;
  operatorAvatar?: string;
  /** Мигать заголовком вкладки, если пришёл ответ, а вкладка скрыта. */
  titleNotify: boolean;
  /** Звук нового сообщения, когда окно закрыто или вкладка скрыта. */
  sound: boolean;
  /** Показывать запросы оценки диалога (карточка «Оцените диалог»). */
  rating: boolean;
  /** Проактивные приглашения по правилам (адрес, задержка, уход со страницы). */
  proactive: ProactiveRule[];
  texts?: Partial<Texts>;
}

/** Что можно передать в window.AvaiChatConfig и AvaiChat.configure(). */
export type ConfigInput = Partial<Omit<WidgetConfig, 'texts' | 'proactive'>> &
  Hooks & { texts?: Partial<Texts>; proactive?: unknown };

/**
 * Тег скрипта виджета. Ищем синхронно при выполнении файла: потом
 * document.currentScript уже null. Для type="module" его нет вовсе —
 * тогда берём тег с data-tenant.
 */
export function findOwnScript(): HTMLScriptElement | null {
  const cur = document.currentScript;
  if (cur instanceof HTMLScriptElement) return cur;
  const own = document.querySelector<HTMLScriptElement>('script[data-tenant][src*="avai-chat"]');
  if (own) return own;
  // Файл переименован: берём тег с data-tenant, только если он на странице один (data-tenant бывает и у чужих скриптов).
  const all = document.querySelectorAll<HTMLScriptElement>('script[data-tenant]');
  return all.length === 1 ? all[0] : null;
}

export function readScriptAttrs(script: HTMLScriptElement | null): ConfigInput {
  if (!script) return {};
  const d = script.dataset;
  const out: ConfigInput = {};
  if (d.api) out.api = d.api;
  if (d.tenant) out.tenant = d.tenant;
  if (d.title) out.title = d.title;
  if (d.operatorName) out.operatorName = d.operatorName;
  if (d.greeting) out.greeting = d.greeting;
  if (d.consentUrl) out.consentUrl = d.consentUrl;
  if (d.autoOpen !== undefined) {
    const n = Number(d.autoOpen);
    if (d.autoOpen !== '' && Number.isFinite(n) && n >= 0) out.autoOpen = n;
  }
  if (d.position === 'left' || d.position === 'right') out.position = d.position;
  if (d.pollWait !== undefined && Number.isFinite(Number(d.pollWait))) out.pollWait = Number(d.pollWait);
  if (d.requireHooks !== undefined) out.requireHooks = d.requireHooks !== 'false';
  if (d.branding !== undefined) out.branding = d.branding !== 'false';
  if (d.attachments !== undefined) out.attachments = d.attachments !== 'false';
  if (d.quickReplies) out.quickReplies = splitList(d.quickReplies);
  if (d.teaser) out.teaser = d.teaser;
  if (d.aiAvatar) out.aiAvatar = d.aiAvatar;
  if (d.operatorAvatar) out.operatorAvatar = d.operatorAvatar;
  if (d.titleNotify !== undefined) out.titleNotify = d.titleNotify !== 'false';
  if (d.sound !== undefined) out.sound = d.sound !== 'false';
  if (d.rating !== undefined) out.rating = d.rating !== 'false';
  if (d.proactive) {
    try {
      out.proactive = JSON.parse(d.proactive);
    } catch {
      console.warn('[avai-chat] data-proactive — не JSON, приглашения выключены');
    }
  }
  return out;
}

export function defaultApi(script: HTMLScriptElement | null): string {
  let origin = location.origin;
  try {
    if (script?.src) origin = new URL(script.src, location.href).origin;
  } catch {
    /* оставляем origin страницы */
  }
  return `${origin}/v1`;
}

/** Приоритет: AvaiChat.configure() > window.AvaiChatConfig > data-* тега. */
export function resolveConfig(script: HTMLScriptElement | null, page: unknown): WidgetConfig {
  const fromPage = isObject(page) ? (page as ConfigInput) : {};
  const merged: ConfigInput = { ...readScriptAttrs(script), ...stripUndefined(fromPage) };
  return {
    api: merged.api || defaultApi(script),
    tenant: merged.tenant ?? '',
    title: merged.title,
    operatorName: merged.operatorName,
    greeting: merged.greeting,
    consentUrl: merged.consentUrl,
    autoOpen: merged.autoOpen,
    position: merged.position === 'left' ? 'left' : 'right',
    pollWait: clamp(merged.pollWait ?? 25, 0, 25),
    requireHooks: merged.requireHooks ?? false,
    branding: merged.branding ?? true,
    attachments: merged.attachments ?? true,
    quickReplies: Array.isArray(merged.quickReplies) ? merged.quickReplies.map(String).filter(Boolean) : undefined,
    teaser: merged.teaser,
    aiAvatar: merged.aiAvatar,
    operatorAvatar: merged.operatorAvatar,
    titleNotify: merged.titleNotify ?? true,
    sound: merged.sound ?? true,
    rating: merged.rating ?? true,
    proactive: normalizeRules(merged.proactive),
    texts: merged.texts,
  };
}

/** «Вопрос 1 | Вопрос 2» → ['Вопрос 1', 'Вопрос 2']. */
function splitList(v: string): string[] {
  return v.split('|').map((x) => x.trim()).filter(Boolean);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
