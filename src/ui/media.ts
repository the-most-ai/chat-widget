/**
 * Когда окно чата разворачивается на весь экран: узкий экран или сенсорный экран малой высоты
 * (телефон в альбомной ориентации — ширина большая, а места по высоте мало).
 * Одна строка для CSS (@media) и для JS (matchMedia), чтобы они не разошлись.
 */
export const FULLSCREEN_MQ = '(max-width: 480px), (pointer: coarse) and (max-height: 500px)';

export function isFullscreen(): boolean {
  return matchMedia(FULLSCREEN_MQ).matches;
}
