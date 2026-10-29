import { css, unsafeCSS } from 'lit';
import { FULLSCREEN_MQ } from './media';

/**
 * Стили внутри Shadow DOM. Только px: rem считается от корня чужой страницы.
 * Наружу торчат CSS-переменные --avai-chat-* и части ::part().
 */
export const styles = css`
  :host {
    --_accent: var(--avai-chat-accent, #1f2937);
    --_accent-text: var(--avai-chat-accent-text, #ffffff);
    --_bg: var(--avai-chat-bg, #ffffff);
    --_text: var(--avai-chat-text, #111827);
    --_muted: var(--avai-chat-muted, #6b7280);
    --_border: var(--avai-chat-border, #e5e7eb);
    --_bot-bg: var(--avai-chat-bot-bg, #f3f4f6);
    --_user-bg: var(--avai-chat-user-bg, var(--_accent));
    --_user-text: var(--avai-chat-user-text, var(--_accent-text));
    --_error: var(--avai-chat-error, #dc2626);
    --_font: var(--avai-chat-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif);
    --_radius: var(--avai-chat-radius, 16px);
    --_width: var(--avai-chat-width, 380px);
    --_height: var(--avai-chat-height, 600px);
    --_offset-x: var(--avai-chat-offset-x, 24px);
    --_offset-y: var(--avai-chat-offset-y, 24px);
    --_launcher: var(--avai-chat-launcher-size, 60px);
    --_shadow: var(--avai-chat-shadow, 0 8px 32px rgba(0, 0, 0, 0.18));
    --_scrollbar: var(--avai-chat-scrollbar, rgba(17, 24, 39, 0.2));
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  [hidden] {
    display: none !important;
  }

  .root {
    font-family: var(--_font);
    font-size: 14px;
    line-height: 20px;
    font-weight: 400;
    color: var(--_text);
    letter-spacing: normal;
    text-align: left;
    text-transform: none;
    -webkit-font-smoothing: antialiased;
  }

  button {
    font: inherit;
    color: inherit;
    margin: 0;
    border: 0;
    background: none;
    cursor: pointer;
    padding: 0;
  }

  button:focus-visible,
  a:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--_accent);
    outline-offset: 2px;
  }

  svg {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 2px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---------- лаунчер ---------- */

  .launcher {
    position: fixed;
    right: var(--_offset-x);
    bottom: var(--_offset-y);
    width: var(--_launcher);
    height: var(--_launcher);
    border-radius: 50%;
    background: var(--_accent);
    color: var(--_accent-text);
    box-shadow: var(--_shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.15s ease;
  }
  .launcher:hover {
    transform: scale(1.05);
  }
  .launcher svg {
    width: 28px;
    height: 28px;
  }
  :host([position='left']) .launcher {
    right: auto;
    left: var(--_offset-x);
  }

  /* ---------- окно ---------- */

  .panel {
    position: fixed;
    right: var(--_offset-x);
    bottom: calc(var(--_offset-y) + var(--_launcher) + 16px);
    width: var(--_width);
    height: var(--_height);
    max-height: calc(100vh - var(--_offset-y) - var(--_launcher) - 40px);
    background: var(--_bg);
    border-radius: var(--_radius);
    box-shadow: var(--_shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  :host([position='left']) .panel {
    right: auto;
    left: var(--_offset-x);
  }

  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 60px;
    padding: 12px 8px 12px 16px;
    border-bottom: 1px solid var(--_border);
    flex: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 16px;
    line-height: 22px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subtitle {
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
  }
  .icon-btn {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--_muted);
    flex: none;
  }
  .icon-btn:hover {
    background: var(--_bot-bg);
    color: var(--_text);
  }
  .icon-btn svg {
    width: 20px;
    height: 20px;
  }
  /* На десктопе чат закрывает лаунчер; крестик — только на телефоне (см. ниже). */
  .icon-btn.close {
    display: none;
  }

  /* ---------- сообщения ---------- */

  .messages {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Тонкий скроллбар вместо системного: стандартные свойства (Chrome 121+, Firefox),
     ::-webkit-scrollbar — для Safari (Chrome при заданных стандартных его игнорирует). */
  .messages,
  .input {
    scrollbar-width: thin;
    scrollbar-color: var(--_scrollbar) transparent;
  }
  .messages::-webkit-scrollbar,
  .input::-webkit-scrollbar {
    width: 6px;
  }
  .messages::-webkit-scrollbar-track,
  .input::-webkit-scrollbar-track {
    background: transparent;
  }
  .messages::-webkit-scrollbar-thumb,
  .input::-webkit-scrollbar-thumb {
    background: var(--_scrollbar);
    border-radius: 3px;
  }

  .row {
    display: flex;
    flex-direction: column;
    max-width: 85%;
  }
  .row.user {
    align-self: flex-end;
    align-items: flex-end;
  }
  .row.bot {
    align-self: flex-start;
    align-items: flex-start;
  }

  .author {
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
    margin: 0 0 2px 12px;
  }

  .bubble {
    padding: 10px 14px;
    border-radius: 18px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: normal;
  }
  .user .bubble {
    background: var(--_user-bg);
    color: var(--_user-text);
    border-bottom-right-radius: 6px;
  }
  .bot .bubble {
    background: var(--_bot-bg);
    color: var(--_text);
    border-bottom-left-radius: 6px;
  }
  .bubble a {
    color: inherit;
    text-decoration: underline;
  }
  .bubble.placeholder {
    color: var(--_muted);
    font-style: italic;
  }

  .meta {
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
    margin-top: 2px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .meta.error {
    color: var(--_error);
  }
  .link-btn {
    color: var(--_accent);
    text-decoration: underline;
    font-size: 12px;
  }

  .system {
    align-self: center;
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
    text-align: center;
    padding: 4px 8px;
  }

  .typing {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--_muted);
    font-size: 12px;
    padding: 4px 0 0 4px;
  }
  .dots {
    display: flex;
    gap: 4px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: blink 1.2s infinite ease-in-out;
  }
  .dots span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .dots span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }

  /* ---------- уведомление, согласие, ввод ---------- */

  .notice {
    margin: 0 12px 8px;
    padding: 8px 12px;
    border-radius: 10px;
    background: #fef6e7;
    color: #7c4a03;
    font-size: 13px;
    line-height: 18px;
    display: flex;
    gap: 8px;
    align-items: flex-start;
    flex: none;
  }
  .notice.config,
  .notice.error,
  .notice.hook {
    background: #fef2f2;
    color: #991b1b;
  }
  .notice-text {
    flex: 1;
  }
  .notice .link-btn {
    color: inherit;
    font-size: 13px;
  }

  .consent {
    padding: 12px 16px;
    border-top: 1px solid var(--_border);
    font-size: 13px;
    line-height: 18px;
    color: var(--_muted);
    flex: none;
  }
  .consent a {
    color: var(--_accent);
  }
  .consent-btn {
    display: block;
    width: 100%;
    margin-top: 10px;
    height: 40px;
    border-radius: 10px;
    background: var(--_accent);
    color: var(--_accent-text);
    font-weight: 600;
  }

  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--_border);
    flex: none;
  }
  .input {
    flex: 1;
    resize: none;
    min-height: 40px;
    max-height: 120px;
    padding: 9px 12px;
    border: 1px solid var(--_border);
    border-radius: 12px;
    background: var(--_bg);
    color: var(--_text);
    font: inherit;
    line-height: 20px;
    margin: 0;
    outline: none;
  }
  .input:focus {
    border-color: var(--_accent);
  }
  .input:disabled {
    opacity: 0.6;
  }
  .send {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--_accent);
    color: var(--_accent-text);
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .send svg {
    width: 20px;
    height: 20px;
  }
  .counter {
    font-size: 11px;
    line-height: 14px;
    color: var(--_muted);
    text-align: right;
    padding: 0 16px 6px;
  }
  .counter.over {
    color: var(--_error);
  }

  /* ---------- время, даты, аватары, разметка ---------- */

  .time {
    font-size: 11px;
    line-height: 14px;
    color: var(--_muted);
    margin: 2px 4px 0;
  }
  .time .read {
    margin-left: 4px;
    letter-spacing: -3px;
    color: var(--_accent);
  }
  .date {
    align-self: center;
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
    padding: 8px 0 4px;
  }
  .row.bot.has-avatar {
    position: relative;
    padding-left: 36px;
  }
  .avatar {
    position: absolute;
    left: 0;
    top: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--_bot-bg);
  }
  .bubble.rich {
    white-space: normal;
  }
  .bubble.rich p {
    margin: 0;
    white-space: pre-wrap;
  }
  .bubble.rich p + p,
  .bubble.rich p + ul,
  .bubble.rich p + ol,
  .bubble.rich ul + p,
  .bubble.rich ol + p {
    margin-top: 8px;
  }
  .bubble.rich ul,
  .bubble.rich ol {
    margin: 0;
    padding-left: 20px;
  }
  .bubble.rich li + li {
    margin-top: 2px;
  }
  .bubble.rich code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 4px;
    padding: 1px 4px;
  }

  /* ---------- быстрые вопросы, подсказка, счётчик ---------- */

  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }
  .quick-btn {
    padding: 7px 12px;
    border: 1px solid var(--_accent);
    border-radius: 16px;
    color: var(--_accent);
    font-size: 13px;
    line-height: 18px;
    text-align: left;
  }
  .quick-btn:hover:not(:disabled) {
    background: var(--_accent);
    color: var(--_accent-text);
  }
  .quick-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 10px;
    background: var(--_error);
    color: #ffffff;
    font-size: 11px;
    line-height: 20px;
    font-weight: 700;
    text-align: center;
  }
  .teaser {
    position: fixed;
    right: var(--_offset-x);
    bottom: calc(var(--_offset-y) + var(--_launcher) + 12px);
    max-width: min(280px, calc(100vw - 2 * var(--_offset-x)));
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 6px 10px 14px;
    background: var(--_bg);
    color: var(--_text);
    border-radius: 14px;
    box-shadow: var(--_shadow);
  }
  :host([position='left']) .teaser {
    right: auto;
    left: var(--_offset-x);
  }
  .teaser-text {
    text-align: left;
    font-size: 14px;
    line-height: 20px;
  }
  .teaser-close {
    width: 24px;
    height: 24px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--_muted);
    border-radius: 6px;
  }
  .teaser-close svg {
    width: 14px;
    height: 14px;
  }

  /* ---------- оценка диалога ---------- */

  .rating-card {
    border: 1px solid var(--_border);
    border-radius: 16px;
    padding: 12px 14px;
    background: var(--_bg);
  }
  .rating-title {
    font-weight: 600;
    margin-bottom: 8px;
  }
  .likes {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .like {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border: 1px solid var(--_border);
    border-radius: 16px;
    font-size: 13px;
    line-height: 18px;
  }
  .like svg {
    width: 16px;
    height: 16px;
  }
  .like:hover:not(:disabled) {
    border-color: var(--_accent);
  }
  .like.on {
    border-color: var(--_accent);
    background: var(--_accent);
    color: var(--_accent-text);
  }
  .like:disabled:not(.on) {
    opacity: 0.4;
    cursor: default;
  }
  .stars {
    display: flex;
    gap: 2px;
  }
  .star {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--_border);
  }
  .star svg {
    width: 26px;
    height: 26px;
    fill: currentColor;
    stroke: none;
  }
  .star.on {
    color: var(--avai-chat-star, #f5a623);
  }
  .star:disabled {
    cursor: default;
  }

  /* ---------- вложения ---------- */

  .panel.drag {
    outline: 2px dashed var(--_accent);
    outline-offset: -6px;
  }
  .attach {
    margin-right: -4px;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--_muted);
    flex: none;
  }
  .attach:hover:not(:disabled) {
    background: var(--_bot-bg);
    color: var(--_text);
  }
  .attach:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .attach svg {
    width: 20px;
    height: 20px;
  }
  .pending {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 12px;
    padding: 6px 4px 6px 6px;
    border: 1px solid var(--_border);
    border-radius: 12px;
    flex: none;
  }
  .pending img {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 8px;
    display: block;
  }
  .pending-name {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    line-height: 16px;
    color: var(--_muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .att-open {
    display: block;
    line-height: 0;
    border-radius: 14px;
    cursor: zoom-in;
  }

  /* Просмотр картинки поверх окна чата (панель — fixed, она и есть контейнер). */
  .viewer {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: var(--avai-chat-viewer-bg, #111827);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 56px 16px 16px;
  }
  .viewer-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 8px 10px 16px;
    color: #ffffff;
  }
  .viewer-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .viewer-btn {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    flex: none;
  }
  .viewer-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  .viewer-btn svg {
    width: 20px;
    height: 20px;
  }
  .viewer-img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 8px;
    cursor: zoom-out;
  }
  .att-img {
    display: block;
    max-width: 240px;
    max-height: 240px;
    border-radius: 14px;
    background: var(--_bot-bg);
    object-fit: cover;
  }
  .att-img.loading {
    width: 160px;
    height: 120px;
  }
  .row .att-img,
  .row .att-link,
  .row .att-file {
    margin-bottom: 4px;
  }
  .att-file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 8px 12px;
    border-radius: 12px;
    background: var(--_bot-bg);
    color: var(--_text);
    font-size: 13px;
    line-height: 18px;
    text-align: left;
  }
  .att-file span:first-of-type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .att-file svg {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .att-file.error {
    color: var(--_error);
  }
  .att-size {
    color: var(--_muted);
    font-size: 12px;
    flex: none;
  }

  .branding {
    flex: none;
    margin-top: -4px;
    padding: 0 12px 8px;
    font-size: 11px;
    line-height: 14px;
    color: var(--_muted);
    text-align: center;
  }
  .branding a {
    color: inherit;
    text-decoration: none;
    font-weight: 600;
  }
  .branding a:hover {
    text-decoration: underline;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* ---------- узкие экраны: на весь экран ---------- */

  /* На весь экран: узкий экран или сенсорный экран малой высоты (телефон в альбомной ориентации). */
  @media ${unsafeCSS(FULLSCREEN_MQ)} {
    .panel {
      /* Видимая область (visualViewport): при открытой клавиатуре iOS поле ввода остаётся над ней. */
      top: var(--_vv-top, 0);
      right: 0;
      bottom: auto;
      left: 0;
      width: 100%;
      height: var(--_vv-height, 100%);
      max-height: none;
      border-radius: 0;
    }
    :host([position='left']) .panel {
      left: 0;
    }
    :host([open]) .launcher {
      display: none;
    }
    .icon-btn.close {
      display: flex;
    }
    .input {
      /* 16px, иначе iOS увеличивает страницу при фокусе. */
      font-size: 16px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .launcher,
    .dots span {
      transition: none;
      animation: none;
    }
  }
`;
