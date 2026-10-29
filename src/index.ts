import { findOwnScript, isObject, resolveConfig, type ConfigInput, type WidgetConfig } from './config';
import { ChatController } from './core/chat';
import { outsideZone } from './core/env';
import { Store } from './core/store';
import { Transport } from './core/transport';
import type { ChatErrorEvent, ChatMessageEvent, Hooks } from './core/types';
import { AvaiChatElement, TAG } from './ui/chat-element';
import { isFullscreen } from './ui/media';
import { normalizeRules } from './ui/proactive';

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

type EventName = 'open' | 'close' | 'message' | 'error' | 'ready' | 'rating' | 'proactive';
type Listener = (detail?: unknown) => void;
type QueuedCall = [string, ...unknown[]];

export interface AvaiChatApi {
  readonly version: string;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  setContext(ctx: Record<string, unknown> | null): void;
  reset(): void;
  on(event: EventName, fn: Listener): () => void;
  off(event: EventName, fn: Listener): void;
  configure(cfg: ConfigInput): void;
  /** Совместимость с очередью-массивом: AvaiChat.push(['open']) работает и после загрузки. */
  push(...calls: QueuedCall[]): number;
  destroy(): void;
}

// Читаем тег синхронно, пока document.currentScript ещё указывает на нас.
const script = findOwnScript();

outsideZone(bootstrap);

function bootstrap(): void {
  const g = window as unknown as { AvaiChat?: unknown; AvaiChatConfig?: unknown };
  const prev = g.AvaiChat as { __avai?: boolean } | undefined;
  if (prev?.__avai) {
    console.warn('[avai-chat] виджет уже загружен на странице, повторная загрузка пропущена');
    return;
  }
  const queued = collectQueue(prev);
  const config = resolveConfig(script, g.AvaiChatConfig);
  const api = createApi(config);
  g.AvaiChat = api;
  for (const call of queued) api.push(call);
}

/**
 * Вызовы до загрузки. Поддерживаем очередь-массив `(window.AvaiChat ||= []).push(['open'])`
 * и заглушку-объект с полем q (как у счётчиков аналитики).
 */
function collectQueue(prev: unknown): QueuedCall[] {
  const list = Array.isArray(prev) ? prev : isObject(prev) && Array.isArray(prev.q) ? prev.q : [];
  return list.filter((c): c is QueuedCall => Array.isArray(c) && typeof c[0] === 'string') as QueuedCall[];
}

function createApi(initial: WidgetConfig): AvaiChatApi {
  let config = initial;
  const listeners = new Map<EventName, Set<Listener>>();
  const pending: Array<() => void> = [];
  let el: AvaiChatElement | null = null;
  let controller: ChatController | null = null;
  let mounted = false;
  let destroyed = false;
  let autoOpenTimer: ReturnType<typeof setTimeout> | undefined;
  const onStorage = (e: StorageEvent) => {
    if (controller && e.key === store?.key) controller.reloadFromStorage();
  };
  let store: Store | null = null;

  const emit = (name: EventName, detail?: unknown) => {
    for (const fn of listeners.get(name) ?? []) {
      try {
        fn(detail);
      } catch (e) {
        console.error(`[avai-chat] обработчик события ${name} упал`, e);
      }
    }
  };

  /** До монтирования вызовы копятся и выполняются по порядку после него. */
  const whenMounted = (fn: () => void) => {
    if (destroyed) return;
    if (mounted) outsideZone(fn);
    else pending.push(fn);
  };

  const applyView = () => {
    if (!el) return;
    el.view = {
      title: config.title,
      operatorName: config.operatorName,
      greeting: config.greeting,
      consentUrl: config.consentUrl,
      branding: config.branding,
      attachments: config.attachments,
      quickReplies: config.quickReplies,
      teaser: config.teaser,
      aiAvatar: config.aiAvatar,
      operatorAvatar: config.operatorAvatar,
      titleNotify: config.titleNotify,
      sound: config.sound,
      rating: config.rating,
    };
    el.setAttribute('position', config.position);
    el.setProactive(config.proactive);
    el.requestUpdate();
  };

  const mount = () => {
    if (destroyed) return;
    if (!config.tenant) {
      console.error('[avai-chat] не задан data-tenant — виджет не запущен');
      return;
    }
    if (!customElements.get(TAG)) customElements.define(TAG, AvaiChatElement);

    store = new Store(config.tenant);
    controller = new ChatController({
      transport: new Transport({ api: config.api, tenant: config.tenant, visitor: store.visitor }),
      store,
      pollWaitSec: config.pollWait,
      consentUrl: config.consentUrl,
      texts: config.texts,
      requireHooks: config.requireHooks,
      hooks: { ...initialHooks },
    });
    controller.subscribe((e) => {
      if (e.type === 'message') emit('message', e.detail as ChatMessageEvent);
      if (e.type === 'error') emit('error', e.detail as ChatErrorEvent);
      if (e.type === 'rating') emit('rating', e.detail);
    });

    // Если сайт поставил тег в разметку сам (например, со своими слотами) — берём его.
    el = document.querySelector<AvaiChatElement>(TAG) ?? document.createElement(TAG) as AvaiChatElement;
    el.onOpenChange = (open) => emit(open ? 'open' : 'close');
    el.onProactive = (detail) => emit('proactive', detail);
    el.attach(controller);
    applyView();
    if (!el.isConnected) document.body.appendChild(el);
    window.addEventListener('storage', onStorage);

    mounted = true;
    for (const fn of pending.splice(0)) fn();

    if (config.autoOpen !== undefined && !controller.autoOpened && !isFullscreen()) {
      autoOpenTimer = setTimeout(() => {
        controller?.markAutoOpened();
        el?.show();
      }, config.autoOpen * 1000);
    }
    emit('ready');
    document.dispatchEvent(new CustomEvent('avai-chat:ready', { detail: { version: VERSION } }));
  };

  // Хуки из window.AvaiChatConfig доступны сразу, до монтирования.
  const rawPageCfg = (window as unknown as { AvaiChatConfig?: unknown }).AvaiChatConfig;
  const pageCfg: ConfigInput = isObject(rawPageCfg) ? (rawPageCfg as ConfigInput) : {};
  const initialHooks: Hooks = stripUndefined({
    beforeSend: pageCfg.beforeSend,
    afterReceive: pageCfg.afterReceive,
    beforeAttach: pageCfg.beforeAttach,
  });

  const api: AvaiChatApi & { __avai: true } = {
    __avai: true,
    version: VERSION,
    get isOpen() {
      return el?.open ?? false;
    },
    open: () => whenMounted(() => el?.show()),
    close: () => whenMounted(() => el?.close()),
    toggle: () => whenMounted(() => el?.toggle()),
    setContext: (ctx) => whenMounted(() => controller?.setContext(isObject(ctx) ? ctx : null)),
    reset: () => whenMounted(() => controller?.reset()),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => api.off(event, fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    configure(cfg) {
      if (!isObject(cfg) || destroyed) return;
      const { beforeSend, afterReceive, beforeAttach, texts, ...raw } = cfg as ConfigInput;
      const hooks = stripUndefined({ beforeSend, afterReceive, beforeAttach });
      const rest = stripUndefined(raw);
      Object.assign(initialHooks, hooks);
      const merge = () => {
        config = { ...config, ...rest } as WidgetConfig;
        if (texts) config.texts = { ...config.texts, ...texts };
        if (rest.proactive !== undefined) config.proactive = normalizeRules(rest.proactive);
      };
      // До монтирования — всё в настройки: контроллер и окно создадутся уже с ними
      // (в том числе api, tenant, pollWait, requireHooks).
      if (!mounted) {
        merge();
        return;
      }
      outsideZone(() => {
        const fixed = (['api', 'tenant', 'pollWait'] as const).filter((k) => k in rest && rest[k] !== config[k]);
        if (fixed.length) console.warn(`[avai-chat] ${fixed.join(', ')} меняются только до загрузки виджета (data-* или AvaiChatConfig)`);
        merge();
        if (Object.keys(hooks).length) controller?.setHooks(hooks);
        if (texts) controller?.setTexts(texts);
        if (rest.requireHooks !== undefined) controller?.setRequireHooks(!!rest.requireHooks);
        if (rest.consentUrl !== undefined) controller?.setConsentUrl(rest.consentUrl ?? null);
        applyView();
      });
    },
    push(...calls) {
      for (const [name, ...args] of calls) {
        const fn = (api as unknown as Record<string, unknown>)[name];
        if (typeof fn === 'function' && name !== 'push') {
          try {
            (fn as (...a: unknown[]) => unknown).apply(api, args);
          } catch (e) {
            console.error(`[avai-chat] вызов ${name} из очереди упал`, e);
          }
        } else {
          console.warn(`[avai-chat] неизвестный вызов в очереди: ${name}`);
        }
      }
      return calls.length;
    },
    destroy() {
      destroyed = true;
      clearTimeout(autoOpenTimer);
      window.removeEventListener('storage', onStorage);
      controller?.destroy();
      el?.remove();
      listeners.clear();
      delete (window as unknown as { AvaiChat?: unknown }).AvaiChat;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => outsideZone(mount), { once: true });
  } else {
    queueMicrotask(() => outsideZone(mount));
  }
  return api;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
