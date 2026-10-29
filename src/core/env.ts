// Мелкие обёртки над окружением браузера.

interface ZoneLike {
  root: { run<T>(fn: () => T): T };
}

/**
 * Выполняет fn вне зоны Angular, если на странице есть zone.js.
 * Иначе каждый таймер опроса и каждый fetch виджета запускал бы проверку
 * изменений во всём приложении сайта (если на нём Angular с zone.js).
 */
export function outsideZone<T>(fn: () => T): T {
  const zone = (globalThis as { Zone?: ZoneLike }).Zone;
  return zone?.root ? zone.root.run(fn) : fn();
}

export function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // randomUUID есть только в защищённом контексте (https, localhost).
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'AbortError';
}

/** Промис с таймаутом: по истечении ms отклоняется ошибкой TimeoutError. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error(`timeout ${ms} ms`);
      e.name = 'TimeoutError';
      reject(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
