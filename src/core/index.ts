// Логика чата без интерфейса. Для своего интерфейса сайта на нашем API:
// а отправку, опрос, повторы, историю и хуки маскирования берёт отсюда.
export { ChatController, MAX_TEXT_LENGTH } from './chat';
export type { ChatControllerOptions, ControllerEvent } from './chat';
export { Transport, ApiError, parseRetryAfter } from './transport';
export type { TransportOptions, SendBody, VisitorTokenStore } from './transport';
export { Store, MAX_STORED_MESSAGES } from './store';
export type { Persisted, StorageLike } from './store';
export { DEFAULT_TEXTS } from './texts';
export type { Texts } from './texts';
export { outsideZone, uuid } from './env';
export { prepareImage, formatSize, AttachError, OUTGOING_MIME, MAX_ATTACHMENT_BYTES } from './attachments';
export type * from './types';
