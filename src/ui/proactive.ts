import { outsideZone } from '../core/env';

/**
 * Проактивное приглашение — заготовленный текст по правилу, как «активные приглашения» в онлайн-консультантах.
 * Пока посетитель не ответил, в шлюз ничего не уходит.
 */
export interface ProactiveRule {
  /** Ключ правила: показывается один раз на посетителя и приходит в context ответа. */
  id: string;
  text: string;
  /** Адрес страницы: подстрока пути (`/tariffs`), строка-регулярка (`/^\/tariffs\/(business|pro)/`) или RegExp. */
  url?: string | RegExp;
  /** Через сколько секунд на странице показать. По умолчанию — сразу. */
  delay?: number;
  /** Показать, когда посетитель уводит мышь за верх окна (уход со страницы). Только мышь, на телефоне не срабатывает. */
  exitIntent?: boolean;
  /** true — сразу открыть чат с этим сообщением; по умолчанию — пузырь у лаунчера. */
  open?: boolean;
}

/** Правила из конфига: отбрасываем кривые, чтобы опечатка на сайте не ломала виджет. */
export function normalizeRules(input: unknown): ProactiveRule[] {
  if (!Array.isArray(input)) return [];
  const out: ProactiveRule[] = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id || typeof x.text !== 'string' || !x.text.trim()) continue;
    out.push({
      id: x.id,
      text: x.text.trim(),
      url: typeof x.url === 'string' || x.url instanceof RegExp ? x.url : undefined,
      delay: typeof x.delay === 'number' && x.delay >= 0 ? x.delay : undefined,
      exitIntent: x.exitIntent === true,
      open: x.open === true,
    });
  }
  return out;
}

export function urlMatches(rule: ProactiveRule, href = location.href): boolean {
  if (rule.url === undefined) return true;
  const u = new URL(href);
  const path = u.pathname + u.search;
  if (rule.url instanceof RegExp) return rule.url.test(path);
  const re = /^\/(.+)\/([a-z]*)$/.exec(rule.url);
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(path);
    } catch {
      return false;
    }
  }
  return path.includes(rule.url);
}

/**
 * Взводит таймеры и уход со страницы для правил текущего адреса. В SPA (Next.js, Angular) адрес
 * меняется без перезагрузки — раз в секунду сверяем его и перевзводим правила для новой страницы.
 */
export class ProactiveEngine {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private exitRules: ProactiveRule[] = [];
  private href = '';
  private watch?: ReturnType<typeof setInterval>;
  private readonly onMouseOut = (e: MouseEvent) => {
    if (e.relatedTarget || e.clientY > 0) return;
    const rule = this.exitRules.shift();
    if (rule) this.fire(rule);
  };

  constructor(
    private rules: ProactiveRule[],
    /** Можно ли показать это правило сейчас (не показывали, чат не открыт и т.п.). */
    private readonly canFire: (rule: ProactiveRule) => boolean,
    private readonly onFire: (rule: ProactiveRule) => void,
  ) {}

  start(): void {
    outsideZone(() => {
      document.addEventListener('mouseout', this.onMouseOut);
      this.watch = setInterval(() => {
        if (location.href !== this.href) this.arm();
      }, 1000);
    });
    this.arm();
  }

  setRules(rules: ProactiveRule[]): void {
    this.rules = rules;
    this.arm();
  }

  stop(): void {
    this.disarm();
    clearInterval(this.watch);
    document.removeEventListener('mouseout', this.onMouseOut);
  }

  private arm(): void {
    this.disarm();
    this.href = location.href;
    for (const rule of this.rules) {
      if (!urlMatches(rule, this.href)) continue;
      if (rule.exitIntent) {
        this.exitRules.push(rule);
        continue;
      }
      this.timers.push(outsideZone(() => setTimeout(() => this.fire(rule), (rule.delay ?? 0) * 1000)));
    }
  }

  private disarm(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.exitRules = [];
  }

  private fire(rule: ProactiveRule): void {
    // Адрес мог смениться, пока шёл таймер.
    if (!urlMatches(rule) || !this.canFire(rule)) return;
    this.onFire(rule);
  }
}
