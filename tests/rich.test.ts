import { describe, expect, it } from 'vitest';
import { inline, safeHref } from '../src/ui/rich';

/** Адреса ссылок из результата inline (ссылка — шаблон с href первым значением). */
function hrefs(parts: unknown[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'object' || p === null) continue;
    const t = p as { strings?: readonly string[]; values?: unknown[] };
    if (t.strings?.[0]?.includes('<a href=')) out.push(String(t.values?.[0]));
    for (const v of t.values ?? []) if (Array.isArray(v)) out.push(...hrefs(v));
  }
  return out;
}

describe('ссылки в ответах ассистента', () => {
  it('голые домены в ответе ассистента', () => {
    const text =
      'Связаться с поддержкой можно по телефону 0890 или в чате. Ссылки: example.ru и мобильное приложение.';
    expect(hrefs(inline(text))).toEqual(['https://example.ru']);
  });

  it('домен с путём, точка в конце предложения не входит в ссылку', () => {
    expect(hrefs(inline('Подробнее: shop.example.ru/catalog.'))).toEqual(['https://shop.example.ru/catalog']);
  });

  it('http(s) и markdown-ссылки', () => {
    expect(hrefs(inline('см. https://example.ru/tariffs, а также [кабинет](https://lk.example.ru)'))).toEqual([
      'https://example.ru/tariffs',
      'https://lk.example.ru',
    ]);
  });

  it('не ссылки: сокращения, числа, файлы, почта', () => {
    expect(hrefs(inline('т.е. версия 3.5, файл photo.jpg, почта info@example.ru, т.д.'))).toEqual([]);
  });

  it('кириллический домен', () => {
    expect(hrefs(inline('Сайт: пример.рф'))).toEqual(['https://пример.рф']);
  });

  it('разрешённые протоколы: http(s), mailto, tel — без учёта регистра', () => {
    expect(hrefs(inline('[почта](mailto:info@example.ru) и [звонок](tel:+78002500890) и [сайт](HTTPS://example.ru)'))).toEqual([
      'mailto:info@example.ru',
      'tel:+78002500890',
      'HTTPS://example.ru',
    ]);
  });

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['java\tscript:alert(1)'],
    ['  javascript:alert(1)'],
    ['java\u0000script:alert(1)'],
    ['jav&#x09;ascript:alert(1)'],
    ['javascript&colon;alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['DATA:text/html;base64,PHNjcmlwdD4='],
    ['vbscript:msgbox(1)'],
    ['VBScript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['//evil.example/x'],
    ['/relative/path'],
    ['ftp://example.ru'],
  ])('опасный или неразрешённый адрес %j — не ссылка, разметка остаётся текстом', (url) => {
    const out = inline(`[нажми](${url})`);
    expect(hrefs(out)).toEqual([]);
    expect(out.join('')).toContain('[нажми](');
    expect(safeHref(url)).toBeNull();
  });

  it('пробелы и управляющие символы вокруг разрешённого адреса убираются', () => {
    expect(safeHref(' https://example.ru ')).toBe('https://example.ru');
    expect(safeHref('ht\ttps://example.ru')).toBe('https://example.ru');
  });
});
