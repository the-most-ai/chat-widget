import { html, type TemplateResult } from 'lit';

/**
 * Безопасное подмножество markdown для ответов ассистента. HTML не разбирается и не вставляется:
 * всё собирается из шаблонов Lit, текст попадает в текстовые узлы, ссылки — только http(s).
 *
 * Блоки: абзацы (переносы строк сохраняются), списки «- », «* », «• » и «1. », заголовки «#…» — жирной строкой.
 * Внутри строки: **жирный**, __жирный__, *курсив*, `код`, [текст](адрес), голые ссылки http(s)
 * и голые домены вроде «example.ru» или «shop.example.ru/catalog» (ассистенты часто пишут адреса без схемы).
 * Домены узнаются только по зоне из списка — чтобы «т.е.», «3.5» или «photo.jpg» не стали ссылками.
 */
export function renderRich(text: string): TemplateResult[] {
  const out: TemplateResult[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined) out.push(html`<p>${inline(joined)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((i) => html`<li>${inline(i)}</li>`);
    out.push(list.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
    list = null;
  };

  for (const line of lines) {
    const bullet = /^\s*(?:[-*•])\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      flushPara();
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (heading) {
      flushPara();
      flushList();
      out.push(html`<p><strong>${inline(heading[1])}</strong></p>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      // Строка без маркера сразу после списка — продолжение последнего пункта не угадываем, начинаем абзац.
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}

const ZONES = 'ru|рф|su|com|net|org|info|online|ai|io|by|kz';
const TOKEN = new RegExp(
  [
    /\*\*([^*\n]+)\*\*/.source,
    /__([^_\n]+)__/.source,
    /`([^`\n]+)`/.source,
    // Адрес ссылки берём любой (даже с пробелами и табами внутри) — и пропускаем через safeHref.
    /\[([^\]\n]+)\]\(([^)\n]+)\)/.source,
    /(https?:\/\/[^\s<>"'«»]+)/.source,
    /\*([^*\s](?:[^*\n]*[^*\s])?)\*/.source,
    // Голый домен: не после @ (почта) и не внутри слова; путь — до пробела или кавычки.
    `(?<![\\p{L}\\d@./-])((?:[a-z0-9а-яё](?:[a-z0-9а-яё-]*[a-z0-9а-яё])?\\.)+(?:${ZONES})(?:\\/[^\\s<>"'«»]*)?)(?![\\p{L}\\d-])`,
  ].join('|'),
  'giu',
);

/** Разметка внутри строки. */
export function inline(text: string): Array<string | TemplateResult> {
  const out: Array<string | TemplateResult> = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    let end = start + m[0].length;
    if (start > last) out.push(text.slice(last, start));
    if (m[1] !== undefined || m[2] !== undefined) {
      out.push(html`<strong>${inline(m[1] ?? m[2])}</strong>`);
    } else if (m[3] !== undefined) {
      out.push(html`<code>${m[3]}</code>`);
    } else if (m[4] !== undefined) {
      const href = safeHref(m[5]);
      // Неразрешённый адрес (javascript:, data: и т.п.) — показываем разметку как есть, текстом.
      out.push(href ? link(href, inline(m[4])) : m[0]);
    } else if (m[6] !== undefined) {
      // У голой ссылки отрезаем знаки препинания в конце: «…на сайте https://example.ru.»
      let url = m[6];
      const trail = /[.,;:!?)\]]+$/.exec(url);
      if (trail) {
        url = url.slice(0, -trail[0].length);
        end -= trail[0].length;
      }
      out.push(link(url, url));
    } else if (m[7] !== undefined) {
      out.push(html`<em>${inline(m[7])}</em>`);
    } else if (m[8] !== undefined) {
      let host = m[8];
      const trail = /[.,;:!?)\]]+$/.exec(host);
      if (trail) {
        host = host.slice(0, -trail[0].length);
        end -= trail[0].length;
      }
      out.push(link(`https://${host}`, host));
    }
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Разрешённые протоколы ссылок в ответах. */
const SAFE_SCHEME = /^(?:https?:\/\/|mailto:|tel:)/i;

/**
 * Адрес для ссылки или null. Браузер, разбирая href, выкидывает пробелы, табы, переводы строк и управляющие
 * символы (`java\tscript:` для него — `javascript:`), поэтому проверяем адрес в том же виде, в каком его
 * поймёт браузер, и пускаем только http(s), mailto и tel — регистр не важен. Остальное (javascript:,
 * vbscript:, data:, относительные адреса) ссылкой не станет.
 */
export function safeHref(raw: string): string | null {
  const url = raw.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  return SAFE_SCHEME.test(url) ? url : null;
}

function link(url: string, label: unknown): TemplateResult {
  // В новой вкладке открываем только веб-ссылки; mailto: и tel: отдаём системе как есть.
  return /^https?:/i.test(url)
    ? html`<a href=${url} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
    : html`<a href=${url} rel="nofollow">${label}</a>`;
}
