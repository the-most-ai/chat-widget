import { LitElement, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import type { ChatController } from '../core/chat';
import { MAX_TEXT_LENGTH } from '../core/chat';
import { AttachError, formatSize, prepareImage } from '../core/attachments';
import { outsideZone } from '../core/env';
import type { ChatAttachment, ChatMessage, OutgoingAttachment, RatingValue } from '../core/types';
import { isFullscreen } from './media';
import { ProactiveEngine, type ProactiveRule } from './proactive';
import { renderRich } from './rich';
import { playPing } from './sound';
import { styles } from './styles';

/** Имя тега. С префиксом продукта, а не сайта: короткие site-* часто заняты компонентами самого сайта. */
export const TAG = 'avai-chat';

export interface ViewConfig {
  title?: string;
  operatorName?: string;
  greeting?: string;
  consentUrl?: string;
  /** Подпись «Работает на AvangardAI» под полем ввода. */
  branding?: boolean;
  /** Скрепка, вставка и перетаскивание картинок. */
  attachments?: boolean;
  /** Кнопки с готовыми вопросами до первого сообщения посетителя. */
  quickReplies?: string[];
  /** Подсказка-пузырь у закрытого лаунчера. */
  teaser?: string;
  /** Аватары (URL картинок) ассистента и оператора. */
  aiAvatar?: string;
  operatorAvatar?: string;
  /** Мигать заголовком вкладки, если пришёл ответ, а вкладка скрыта. */
  titleNotify?: boolean;
  /** Звук нового сообщения, когда окно закрыто или вкладка скрыта. */
  sound?: boolean;
  /** Карточки запроса оценки диалога. */
  rating?: boolean;
}

const TEASER_DELAY_MS = 3000;

const BRAND_URL = 'https://avangardai.ru';
const COUNTER_FROM = MAX_TEXT_LENGTH - 500;

/**
 * Свойства хоста, которые нельзя отдавать теме сайта: `*{...}`, `div:empty{display:none}`
 * и подобное снаружи побеждают правила :host. Ставим через CSSOM с !important —
 * так работает при CSP без 'unsafe-inline' в style-src (setAttribute('style') там запрещён).
 */
const HOST_STYLE: Array<[string, string]> = [
  ['all', 'initial'],
  ['display', 'block'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['width', '0'],
  ['height', '0'],
  ['overflow', 'visible'],
  ['z-index', 'var(--avai-chat-z, 2147483000)'],
];

export class AvaiChatElement extends LitElement {
  static override styles = styles;

  controller?: ChatController;
  view: ViewConfig = {};
  /** Вызывается при открытии и закрытии — API шлёт события open/close. */
  onOpenChange?: (open: boolean) => void;
  /** Показ приглашения и что с ним сделал посетитель — API шлёт событие proactive. */
  onProactive?: (detail: { id: string; action: 'shown' | 'opened' | 'dismissed' }) => void;

  /** Приглашение, которое сейчас висит пузырём у лаунчера. */
  private proactiveBubble: ProactiveRule | null = null;
  private proactiveEngine?: ProactiveEngine;

  private isOpen = false;
  private draft = '';
  /** Картинка, подготовленная к отправке вместе с текстом. */
  private pending: OutgoingAttachment | null = null;
  private attaching = false;
  private dragOver = false;
  /** Файлы входящих: id → blob: URL или 'error'. */
  private readonly fileUrls = new Map<string, string>();
  /** Свои картинки посетителя в полном размере, пока страница открыта: превью → blob: URL. */
  private readonly ownFull = new Map<string, string>();
  /** Открытая в просмотре картинка. */
  private viewer: { src: string; name: string; download: boolean } | null = null;
  private stickToBottom = true;
  private unsubscribe?: () => void;
  private savedOverflow: string | null = null;
  private vvSync?: () => void;
  private teaserReady = false;
  private teaserTimer?: ReturnType<typeof setTimeout>;
  private titleTimer?: ReturnType<typeof setInterval>;
  private pageTitle = '';
  private titleNotice = '';
  private readonly onVisibility = () => {
    this.syncActive();
    this.syncTitle();
  };
  private readonly onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Esc сначала закрывает просмотр картинки, вторым нажатием — чат.
    if (this.viewer) this.closeViewer();
    else if (this.isOpen) this.close();
  };

  get open(): boolean {
    return this.isOpen;
  }

  attach(controller: ChatController): void {
    this.unsubscribe?.();
    this.controller = controller;
    this.unsubscribe = controller.subscribe((e) => {
      // Сигнал — только о том, что посетитель не видит: окно закрыто или вкладка скрыта.
      if (e.type === 'message' && e.detail.direction === 'in' && this.view.sound !== false && !(this.isOpen && !document.hidden)) {
        outsideZone(playPing);
      }
      if (e.type === 'change') {
        this.requestUpdate();
        this.syncTitle();
      }
    });
    this.requestUpdate();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    for (const [k, v] of HOST_STYLE) this.style.setProperty(k, v, 'important');
    outsideZone(() => {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.addEventListener('keydown', this.onKeydown);
      this.teaserTimer = setTimeout(() => {
        this.teaserReady = true;
        this.requestUpdate();
      }, TEASER_DELAY_MS);
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.removeEventListener('keydown', this.onKeydown);
    this.unlockScroll();
    clearTimeout(this.teaserTimer);
    this.proactiveEngine?.stop();
    this.stopTitle();
    this.controller?.setActive(false);
    // Полноразмерные свои картинки (до 15 МБ каждая) держали blob: URL — освобождаем.
    for (const url of this.ownFull.values()) URL.revokeObjectURL(url);
    this.ownFull.clear();
  }

  // ---------- проактивные приглашения ----------

  /** Правила приглашений с сайта; движок взводится один раз и перечитывает правила при смене. */
  setProactive(rules: ProactiveRule[]): void {
    if (!this.proactiveEngine) {
      if (!rules.length) return;
      this.proactiveEngine = new ProactiveEngine(
        rules,
        (rule) => this.canShowProactive(rule),
        (rule) => this.fireProactive(rule),
      );
      this.proactiveEngine.start();
    } else {
      this.proactiveEngine.setRules(rules);
    }
  }

  /** Не мешаем: правило уже показывали, чат открыт, уже висит приглашение или посетитель недавно писал сам. */
  private canShowProactive(rule: ProactiveRule): boolean {
    const c = this.controller;
    if (!c || this.isOpen || this.proactiveBubble || c.proactiveShown(rule.id) || c.state.blocked) return false;
    const recent = Date.now() - 30 * 60_000;
    return !c.state.messages.some((m) => m.sender === 'user' && Date.parse(m.createdAt) > recent);
  }

  private fireProactive(rule: ProactiveRule): void {
    this.controller!.markProactiveShown(rule.id);
    this.onProactive?.({ id: rule.id, action: 'shown' });
    if (rule.open) {
      this.proactiveBubble = rule;
      this.show();
    } else {
      this.proactiveBubble = rule;
      this.requestUpdate();
    }
  }

  private dismissProactive(): void {
    const rule = this.proactiveBubble;
    if (!rule) return;
    this.proactiveBubble = null;
    this.requestUpdate();
    this.onProactive?.({ id: rule.id, action: 'dismissed' });
  }

  // ---------- заголовок вкладки ----------

  /** Вкладка скрыта и есть непрочитанное — заголовок чередуется с «(1) Новое сообщение». */
  private syncTitle(): void {
    const unread = this.controller?.state.unread ?? 0;
    const want = this.view.titleNotify !== false && document.hidden && unread > 0;
    if (!want) {
      this.stopTitle();
      return;
    }
    this.titleNotice = `(${unread}) ${this.controller!.texts.newMessage}`;
    if (this.titleTimer) return;
    this.titleTimer = outsideZone(() =>
      setInterval(() => {
        if (document.title === this.titleNotice) {
          document.title = this.pageTitle;
        } else {
          // Заголовок мог смениться самим сайтом (SPA) — запоминаем актуальный.
          this.pageTitle = document.title;
          document.title = this.titleNotice;
        }
      }, 1500),
    );
  }

  private stopTitle(): void {
    if (!this.titleTimer) return;
    clearInterval(this.titleTimer);
    this.titleTimer = undefined;
    if (document.title === this.titleNotice) document.title = this.pageTitle;
  }

  // ---------- открытие/закрытие ----------

  show(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.toggleAttribute('open', true);
    // Открыли при висящем приглашении (по пузырю или лаунчеру) — оно становится сообщением в ленте.
    const rule = this.proactiveBubble;
    if (rule) {
      this.proactiveBubble = null;
      this.controller?.addProactiveMessage(rule.id, rule.text, {
        proactive: rule.id,
        proactive_text: rule.text,
        // Без query и #: в них бывают email, токены и прочее, чего маскирование не видит.
        page: location.origin + location.pathname,
      });
      this.onProactive?.({ id: rule.id, action: 'opened' });
    }
    // Открыли чат — подсказка у лаунчера больше не нужна.
    if (this.view.teaser) this.controller?.dismissTeaser();
    this.stickToBottom = true;
    this.lockScroll();
    this.syncActive();
    this.requestUpdate();
    this.updateComplete.then(() => {
      // На телефоне не фокусируем: клавиатура закроет половину экрана без спроса.
      if (!isFullscreen()) this.textarea?.focus();
      this.scrollToBottom();
    });
    this.onOpenChange?.(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.toggleAttribute('open', false);
    this.unlockScroll();
    this.syncActive();
    this.requestUpdate();
    this.updateComplete.then(() => this.launcher?.focus());
    this.onOpenChange?.(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }

  private syncActive(): void {
    this.controller?.setActive(this.isOpen && !document.hidden);
  }

  /** На весь экран на телефоне: страница под чатом не должна прокручиваться. */
  private lockScroll(): void {
    if (!isFullscreen() || this.savedOverflow !== null) return;
    const s = document.documentElement.style;
    this.savedOverflow = s.overflow;
    s.overflow = 'hidden';
    this.followViewport(true);
  }

  private unlockScroll(): void {
    this.followViewport(false);
    if (this.savedOverflow === null) return;
    document.documentElement.style.overflow = this.savedOverflow;
    this.savedOverflow = null;
  }

  /**
   * На весь экран окно подгоняем под видимую область (visualViewport): на iOS экранная клавиатура
   * не уменьшает окно браузера, а перекрывает его, и поле ввода уехало бы под клавиатуру.
   * Размеры кладём в CSS-переменные хоста через CSSOM — это разрешено и при строгом CSP.
   */
  private followViewport(on: boolean): void {
    const vv = window.visualViewport;
    if (!vv) return;
    if (on && !this.vvSync) {
      this.vvSync = () => {
        this.style.setProperty('--_vv-top', `${Math.round(vv.offsetTop)}px`);
        this.style.setProperty('--_vv-height', `${Math.round(vv.height)}px`);
        if (this.stickToBottom) this.scrollToBottom();
      };
      outsideZone(() => {
        vv.addEventListener('resize', this.vvSync!);
        vv.addEventListener('scroll', this.vvSync!);
      });
      this.vvSync();
    } else if (!on && this.vvSync) {
      vv.removeEventListener('resize', this.vvSync);
      vv.removeEventListener('scroll', this.vvSync);
      this.vvSync = undefined;
      this.style.removeProperty('--_vv-top');
      this.style.removeProperty('--_vv-height');
    }
  }

  // ---------- отправка ----------

  private get textarea(): HTMLTextAreaElement | null {
    return this.renderRoot.querySelector('textarea');
  }

  private get launcher(): HTMLButtonElement | null {
    return this.renderRoot.querySelector('.launcher');
  }

  private async submit(): Promise<void> {
    const c = this.controller;
    if (!c) return;
    const text = this.draft;
    const attachment = this.pending ?? undefined;
    this.stickToBottom = true;
    const ok = await c.send(text, attachment);
    // При сбое хука текст и вложение остаются — посетитель повторит отправку.
    if (ok) {
      if (attachment?.thumb && !this.ownFull.has(attachment.thumb)) {
        this.ownFull.set(attachment.thumb, URL.createObjectURL(attachment.blob));
      }
      if (this.pending === attachment) this.pending = null;
      if (this.draft === text) {
        this.draft = '';
        const ta = this.textarea;
        if (ta) {
          ta.value = '';
          this.autosize(ta);
        }
      }
      this.requestUpdate();
    }
  }

  /** «Повторить» после сбоя хука: черновик в поле или текст быстрой кнопки, которого в поле нет. */
  private retryAfterHook(retryText?: string): void {
    if (!this.draft.trim() && !this.pending && retryText) void this.sendQuick(retryText);
    else void this.submit();
  }

  private async sendQuick(text: string): Promise<void> {
    this.stickToBottom = true;
    await this.controller?.send(text);
  }

  // ---------- вложения ----------

  private async attachFile(file: File | Blob | null | undefined): Promise<void> {
    const c = this.controller;
    if (!c || !file || !this.view.attachments) return;
    const t = c.texts;
    this.attaching = true;
    this.requestUpdate();
    try {
      this.pending = await prepareImage(file);
      c.dismissNotice();
    } catch (e) {
      const code = e instanceof AttachError ? e.code : 'decode';
      c.showError(code === 'unsupported' ? t.attachUnsupported : code === 'too_large' ? t.attachTooLarge : t.attachFailed);
    } finally {
      this.attaching = false;
      this.requestUpdate();
    }
  }

  private onFilePicked(e: Event): void {
    const input = e.target as HTMLInputElement;
    void this.attachFile(input.files?.[0]);
    input.value = '';
  }

  private onPaste(e: ClipboardEvent): void {
    if (!this.view.attachments) return;
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void this.attachFile(file);
    }
  }

  private onDragOver(e: DragEvent): void {
    if (!this.view.attachments || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!this.dragOver) {
      this.dragOver = true;
      this.requestUpdate();
    }
  }

  private onDragLeave(e: DragEvent): void {
    if (e.currentTarget === e.target || !(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) {
      this.dragOver = false;
      this.requestUpdate();
    }
  }

  private onDrop(e: DragEvent): void {
    if (!this.view.attachments) return;
    e.preventDefault();
    this.dragOver = false;
    void this.attachFile(e.dataTransfer?.files?.[0]);
  }

  /** blob: URL входящего файла; загрузку запускает первый показ. */
  private fileUrl(id: string): string | undefined {
    const known = this.fileUrls.get(id);
    if (known !== undefined) return known;
    this.fileUrls.set(id, '');
    this.controller!.loadFile(id).then(
      (url) => this.fileUrls.set(id, url),
      () => this.fileUrls.set(id, 'error'),
    ).finally(() => this.requestUpdate());
    return '';
  }

  private openViewer(src: string, name: string, download: boolean): void {
    this.viewer = { src, name, download };
    this.requestUpdate();
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>('.viewer-close')?.focus());
  }

  private closeViewer(): void {
    this.viewer = null;
    this.requestUpdate();
  }

  /** Скачать входящий документ: по клику, а не при показе. */
  private async download(a: ChatAttachment): Promise<void> {
    if (!a.id) return;
    try {
      const url = await this.controller!.loadFile(a.id);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.name;
      link.rel = 'noopener';
      this.renderRoot.appendChild(link);
      link.click();
      link.remove();
    } catch {
      this.controller!.showError(this.controller!.texts.fileLoadFailed);
    }
  }

  private onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    this.draft = ta.value;
    this.autosize(ta);
    this.requestUpdate();
  }

  private onComposerKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.submit();
    }
  }

  private autosize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 120)}px`;
  }

  // ---------- прокрутка ----------

  private onScroll(e: Event): void {
    const el = e.target as HTMLElement;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  private scrollToBottom(): void {
    const el = this.renderRoot.querySelector('.messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this.isOpen && this.stickToBottom) this.scrollToBottom();
  }

  // ---------- отрисовка ----------

  protected override render(): TemplateResult {
    const c = this.controller;
    const t = c?.texts;
    if (!c || !t) return html``;
    const st = c.state;
    const title = this.view.title || t.title;
    const operatorName = this.view.operatorName || t.operatorName;
    const lastIncoming = [...st.messages].reverse().find((m) => m.sender === 'ai' || m.sender === 'operator');
    const operatorActive = lastIncoming?.sender === 'operator';
    const inputDisabled = st.blocked || !st.consentAccepted || st.preparing;
    const tooLong = this.draft.length > MAX_TEXT_LENGTH;
    const canSend = !inputDisabled && !this.attaching && (this.draft.trim().length > 0 || !!this.pending) && !tooLong;
    const attachOn = !!this.view.attachments;

    return html`
      <div class="root">
        <button
          class="launcher"
          part="launcher"
          aria-label=${this.isOpen ? t.closeLabel : t.launcherLabel}
          aria-expanded=${this.isOpen ? 'true' : 'false'}
          @click=${() => this.toggle()}
        >
          <slot name="launcher-icon">${this.isOpen ? iconClose : iconChat}</slot>
          ${!this.isOpen && st.unread > 0
            ? html`<span class="badge" part="badge" aria-label=${`${t.newMessage}: ${st.unread}`}>${st.unread > 9 ? '9+' : st.unread}</span>`
            : nothing}
        </button>

        ${this.proactiveBubble && !this.isOpen
          ? html`<div class="teaser proactive" part="teaser proactive">
              <button class="teaser-text" @click=${() => this.show()}>${this.proactiveBubble.text}</button>
              <button class="teaser-close" aria-label=${t.closeLabel} title=${t.closeLabel} @click=${() => this.dismissProactive()}>${iconClose}</button>
            </div>`
          : this.teaserReady && this.view.teaser && !this.isOpen && !c.teaserDismissed
          ? html`<div class="teaser" part="teaser">
              <button class="teaser-text" @click=${() => this.show()}>${this.view.teaser}</button>
              <button class="teaser-close" aria-label=${t.closeLabel} title=${t.closeLabel} @click=${() => c.dismissTeaser()}>${iconClose}</button>
            </div>`
          : nothing}
        <section
          class="panel ${this.dragOver ? 'drag' : ''}"
          part="panel"
          role="dialog"
          aria-label=${title}
          ?hidden=${!this.isOpen}
          @dragover=${this.onDragOver}
          @dragleave=${this.onDragLeave}
          @drop=${this.onDrop}
        >
          <header class="header" part="header">
            <slot name="logo"></slot>
            <div class="titles">
              <div class="title" part="title">${title}</div>
              ${operatorActive ? html`<div class="subtitle">${lastIncoming?.name || operatorName}</div>` : nothing}
            </div>
            <!-- Закрывает чат лаунчер снизу. Крестик виден только на телефоне: там окно на весь экран и лаунчер скрыт. -->
            <button class="icon-btn close" part="close" title=${t.closeLabel} aria-label=${t.closeLabel} @click=${() => this.close()}>
              ${iconClose}
            </button>
          </header>

          <div class="messages" part="messages" role="log" aria-live="polite" @scroll=${this.onScroll}>
            ${this.view.greeting ? this.renderBubble('bot', this.view.greeting, { groupStart: true }) : nothing}
            ${this.view.quickReplies?.length && st.consentAccepted && !st.blocked && !st.messages.some((m) => m.sender === 'user')
              ? html`<div class="quick" part="quick-replies">
                  ${this.view.quickReplies.map(
                    (q) => html`<button class="quick-btn" part="quick-reply" ?disabled=${st.preparing} @click=${() => this.sendQuick(q)}>${q}</button>`,
                  )}
                </div>`
              : nothing}
            ${this.renderFeed(st.messages, operatorName)}
            ${st.awaiting
              ? html`<div class="typing" part="typing" role="status">
                  <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>${t.typing}
                </div>`
              : nothing}
          </div>

          ${st.notice
            ? html`<div class="notice ${st.notice.kind}" part="notice" role="alert">
                <span class="notice-text">${st.notice.text}</span>
                ${st.notice.kind === 'hook'
                  ? html`<button class="link-btn" @click=${() => this.retryAfterHook(st.notice?.retryText)}>${t.retry}</button>`
                  : nothing}
                ${st.notice.kind !== 'config'
                  ? html`<button class="link-btn" aria-label="OK" @click=${() => c.dismissNotice()}>×</button>`
                  : nothing}
              </div>`
            : nothing}
          ${!st.consentAccepted && this.view.consentUrl
            ? html`<div class="consent" part="consent">
                ${t.consentText}
                <a href=${this.view.consentUrl} target="_blank" rel="noopener noreferrer">${t.consentLink}</a>.
                <button class="consent-btn" part="consent-accept" @click=${() => this.acceptConsent()}>
                  ${t.consentAccept}
                </button>
              </div>`
            : nothing}
          ${this.draft.length > COUNTER_FROM
            ? html`<div class="counter ${tooLong ? 'over' : ''}" part="counter">
                ${tooLong ? `${t.tooLong}: ` : ''}${this.draft.length} / ${MAX_TEXT_LENGTH}
              </div>`
            : nothing}
          ${this.pending
            ? html`<div class="pending" part="attachment-preview">
                ${this.pending.thumb ? html`<img src=${this.pending.thumb} alt="" />` : nothing}
                <span class="pending-name">${this.pending.name} · ${formatSize(this.pending.blob.size)}</span>
                <button
                  class="icon-btn"
                  title=${t.removeAttachment}
                  aria-label=${t.removeAttachment}
                  @click=${() => {
                    this.pending = null;
                    this.requestUpdate();
                  }}
                >
                  ${iconClose}
                </button>
              </div>`
            : nothing}
          <div class="composer" part="composer">
            <label class="sr-only" for="avai-input">${t.inputPlaceholder}</label>
            <textarea
              id="avai-input"
              class="input"
              part="input"
              rows="1"
              .value=${this.draft}
              placeholder=${t.inputPlaceholder}
              ?disabled=${inputDisabled}
              @input=${this.onInput}
              @keydown=${this.onComposerKeydown}
              @paste=${this.onPaste}
            ></textarea>
            ${attachOn
              ? html`<button
                    class="attach"
                    part="attach"
                    title=${t.attachLabel}
                    aria-label=${t.attachLabel}
                    ?disabled=${inputDisabled || this.attaching}
                    @click=${() => this.renderRoot.querySelector<HTMLInputElement>('.file-input')?.click()}
                  >
                    ${iconClip}
                  </button>
                  <input class="file-input" type="file" accept="image/*" hidden @change=${this.onFilePicked} />`
              : nothing}
            <button
              class="send"
              part="send"
              aria-label=${t.sendLabel}
              title=${t.sendLabel}
              ?disabled=${!canSend}
              @click=${() => this.submit()}
            >
              ${iconSend}
            </button>
          </div>
          ${this.view.branding !== false
            ? html`<div class="branding" part="branding">
                ${t.poweredBy} <a href=${BRAND_URL} target="_blank" rel="noopener noreferrer">AvangardAI</a>
              </div>`
            : nothing}
          ${this.viewer ? this.renderViewer(this.viewer) : nothing}
        </section>
      </div>
    `;
  }

  private acceptConsent(): void {
    this.controller?.acceptConsent();
    this.updateComplete.then(() => this.textarea?.focus());
  }

  /** Просмотр картинки поверх окна чата: клик по фону, крестик или Esc закрывают. */
  private renderViewer(v: ViewerState): TemplateResult {
    const t = this.controller!.texts;
    return html`<div
      class="viewer"
      part="viewer"
      role="dialog"
      aria-label=${v.name}
      @click=${(e: Event) => e.target === e.currentTarget && this.closeViewer()}
    >
      <div class="viewer-bar">
        <span class="viewer-name">${v.name}</span>
        ${v.download
          ? html`<a class="viewer-btn" href=${v.src} download=${v.name} title=${t.download} aria-label=${t.download}>${iconDownload}</a>`
          : nothing}
        <button class="viewer-btn viewer-close" title=${t.closeImage} aria-label=${t.closeImage} @click=${() => this.closeViewer()}>
          ${iconClose}
        </button>
      </div>
      <img class="viewer-img" src=${v.src} alt=${v.name} @click=${() => this.closeViewer()} />
    </div>`;
  }

  /** Лента: разделители дат, группы сообщений одного отправителя (аватар — у первого в группе). */
  private renderFeed(messages: ChatMessage[], operatorName: string): TemplateResult[] {
    const out: TemplateResult[] = [];
    let day = '';
    let prevSender = this.view.greeting ? 'ai' : '';
    for (const m of messages) {
      const d = new Date(m.createdAt);
      const key = Number.isNaN(d.getTime()) ? day : d.toDateString();
      if (key !== day) {
        // Над первым сообщением истории дату не ставим, если это сегодня: и так понятно.
        if (day || key !== new Date().toDateString()) {
          out.push(html`<div class="date" part="date">${this.dayLabel(d)}</div>`);
        }
        day = key;
        prevSender = '';
      }
      out.push(this.renderMessage(m, operatorName, m.sender !== prevSender));
      prevSender = m.sender;
    }
    return out;
  }

  private dayLabel(d: Date): string {
    const t = this.controller!.texts;
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t.today;
    if (d.toDateString() === yesterday.toDateString()) return t.yesterday;
    return d.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    });
  }

  private renderMessage(m: ChatMessage, operatorName: string, groupStart: boolean): TemplateResult {
    const t = this.controller!.texts;
    if (m.sender === 'system') return html`<div class="system" part="system">${m.text}</div>`;
    const time = timeOf(m.createdAt);
    if (m.sender === 'user') {
      return html`<div class="row user">
        ${this.renderAttachments(m.attachments, true)}
        ${m.text ? html`<div class="bubble" part="message message-user">${linkify(m.text)}</div>` : nothing}
        ${m.status === 'failed'
          ? html`<div class="meta error" part="message-status">
              ${m.error || t.failed}
              ${m.final ? nothing : html`<button class="link-btn" @click=${() => this.controller!.retry(m.id)}>${t.retry}</button>`}
            </div>`
          : html`<div class="time" part="time">
              ${time}${m.read
                ? html`<span class="read" part="message-read" title=${t.read} aria-label=${t.read}>✓✓</span>`
                : nothing}
            </div>`}
      </div>`;
    }
    const isOperator = m.sender === 'operator';
    if (m.ratingRequest) return this.view.rating === false ? html`` : this.renderRatingCard(m);
    if (m.unprocessed) {
      return html`<div class="row bot">
        <div class="bubble placeholder" part="message message-bot">${t.receiveFailed}</div>
        <div class="meta"><button class="link-btn" @click=${() => this.controller!.retryReceive(m.id)}>${t.retry}</button></div>
      </div>`;
    }
    return this.renderBubble(isOperator ? 'operator' : 'bot', m.text, {
      author: isOperator && groupStart ? m.name || operatorName : undefined,
      attachments: m.attachments,
      groupStart,
      time,
    });
  }

  private renderBubble(
    kind: 'bot' | 'operator',
    text: string,
    o: { author?: string; attachments?: ChatAttachment[]; groupStart: boolean; time?: string },
  ): TemplateResult {
    const part = kind === 'operator' ? 'message message-bot message-operator' : 'message message-bot';
    const avatar = kind === 'operator' ? this.view.operatorAvatar : this.view.aiAvatar;
    return html`<div class="row bot ${avatar ? 'has-avatar' : ''}">
      ${avatar && o.groupStart ? html`<img class="avatar" part="avatar" src=${avatar} alt="" />` : nothing}
      ${o.author ? html`<div class="author" part="author">${o.author}</div>` : nothing}
      ${text ? html`<div class="bubble rich" part=${part}>${renderRich(text)}</div>` : nothing}
      ${this.renderAttachments(o.attachments)}
      ${o.time ? html`<div class="time" part="time">${o.time}</div>` : nothing}
    </div>`;
  }

  /** Карточка «Оцените диалог»: текст всегда наш, ответ — один раз. */
  private renderRatingCard(m: ChatMessage): TemplateResult {
    const t = this.controller!.texts;
    const req = m.ratingRequest!;
    const done = !!req.value && !req.sending;
    const locked = !!req.value;
    const rate = (value: RatingValue) => this.controller!.rate(m.id, value);
    let controls: TemplateResult;
    if (req.scale === 'stars') {
      const chosen = req.value && 'stars' in req.value ? req.value.stars : 0;
      const shown = locked ? chosen : this.starHover.get(m.id) ?? 0;
      controls = html`<div class="stars" role="radiogroup" aria-label=${t.ratingPrompt} @mouseleave=${() => this.setStarHover(m.id, 0)}>
        ${[1, 2, 3, 4, 5].map(
          (n) => html`<button
            class="star ${n <= shown ? 'on' : ''}"
            part="rating-star"
            role="radio"
            aria-checked=${chosen === n ? 'true' : 'false'}
            aria-label=${`${t.ratingStar}: ${n}`}
            ?disabled=${locked}
            @mouseenter=${() => this.setStarHover(m.id, n)}
            @click=${() => rate({ stars: n })}
          >
            ${iconStar}
          </button>`,
        )}
      </div>`;
    } else {
      const liked = req.value && 'liked' in req.value ? req.value.liked : undefined;
      const btn = (value: boolean, label: string, icon: TemplateResult) =>
        html`<button
          class="like ${liked === value ? 'on' : ''}"
          part=${value ? 'rating-like' : 'rating-dislike'}
          aria-pressed=${liked === value ? 'true' : 'false'}
          ?disabled=${locked}
          @click=${() => rate({ liked: value })}
        >
          ${icon}<span>${label}</span>
        </button>`;
      controls = html`<div class="likes">${btn(true, t.ratingLiked, iconUp)}${btn(false, t.ratingDisliked, iconDown)}</div>`;
    }
    return html`<div class="row bot ${this.view.aiAvatar ? 'has-avatar' : ''}">
      <div class="rating-card" part="rating-card">
        <div class="rating-title">${done ? t.ratingThanks : t.ratingPrompt}</div>
        ${controls}
      </div>
    </div>`;
  }

  private readonly starHover = new Map<string, number>();

  private setStarHover(id: string, n: number): void {
    this.starHover.set(id, n);
    this.requestUpdate();
  }

  private renderAttachments(list?: ChatAttachment[], own = false): TemplateResult | typeof nothing {
    if (!list?.length) return nothing;
    const t = this.controller!.texts;
    return html`${list.map((a) => {
      // Своя картинка посетителя: в ленте — превью из кэша; в просмотре — полный размер,
      // пока страница не перезагружена (сам файл в браузере не хранится). Без превью (другая
      // вкладка, история шлюза) своя картинка грузится с шлюза, как входящая.
      if (a.thumb || !a.id) {
        if (!a.thumb) return html`<div class="att-file" part="attachment-file">${iconClip}<span>${a.name}</span></div>`;
        const thumb = a.thumb;
        return html`<button class="att-open" title=${t.openImage} @click=${() => this.openViewer(this.ownFull.get(thumb) ?? thumb, a.name, false)}>
          <img class="att-img" part="attachment-image" src=${thumb} alt=${a.name} />
        </button>`;
      }
      if (a.mimeType.startsWith('image/')) {
        const url = this.fileUrl(a.id);
        if (url === 'error') {
          // Свою картинку шлюз хранит, только пока не передал боту: потом 404 — это норма, показываем имя.
          return own
            ? html`<div class="att-file" part="attachment-file">${iconClip}<span>${a.name}</span></div>`
            : html`<div class="att-file error" part="attachment-file">${t.fileLoadFailed}: ${a.name}</div>`;
        }
        if (!url) return html`<div class="att-img loading" part="attachment-image" aria-label=${a.name}></div>`;
        return html`<button class="att-open" title=${t.openImage} @click=${() => this.openViewer(url, a.name, true)}>
          <img class="att-img" part="attachment-image" src=${url} alt=${a.name} />
        </button>`;
      }
      return html`<button class="att-file" part="attachment-file" title=${t.download} @click=${() => this.download(a)}>
        ${iconClip}<span>${a.name}</span><span class="att-size">${formatSize(a.size)}</span>
      </button>`;
    })}`;
  }
}

export interface ViewerState {
  src: string;
  name: string;
  download: boolean;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const URL_RE = /https?:\/\/[^\s<>"'«»]+/g;

/**
 * Текст ответа — только текст: Lit вставляет его текстовыми узлами, HTML не исполняется.
 * Ссылки http(s) делаем кликабельными, собирая <a> самим, а не из разметки ответа.
 */
export function linkify(text: string): Array<string | TemplateResult> {
  const out: Array<string | TemplateResult> = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(html`<a href=${url} target="_blank" rel="noopener noreferrer nofollow">${url}</a>`);
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const iconChat = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  ${svg`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"></path>`}
</svg>`;
const iconClose = html`<svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d="M6 6l12 12M18 6L6 18"></path>`}</svg>`;
const iconClip = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  ${svg`<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"></path>`}
</svg>`;
const iconDownload = html`<svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path>`}</svg>`;
const iconUp = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  ${svg`<path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"></path>`}
</svg>`;
const iconDown = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  ${svg`<path d="M17 13V4h3v9h-3Zm0 0-4 7a2 2 0 0 1-2-2v-4H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7.2 4H17"></path>`}
</svg>`;
const iconStar = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  ${svg`<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"></path>`}
</svg>`;
const iconSend = html`<svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d="M5 12h13M13 6l6 6-6 6"></path>`}</svg>`;
