import type { OutgoingAttachment } from './types';

/** Что шлюз принимает от посетителя. */
export const OUTGOING_MIME = ['image/png', 'image/jpeg', 'image/gif'];
/** Предел шлюза, байт. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Сколько принимаем на вход до ужатия: фото с телефона бывают по 10–20 МБ, после ужатия — в разы меньше. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

const MAX_SIDE = 2048;
const JPEG_QUALITY = 0.85;
const THUMB_SIDE = 320;

export class AttachError extends Error {
  constructor(
    readonly code: 'unsupported' | 'too_large' | 'decode',
    message: string,
  ) {
    super(message);
    this.name = 'AttachError';
  }
}

/**
 * Картинка посетителя → то, что уходит в шлюз, плюс маленькое превью для истории.
 * - GIF — как есть (сохраняется анимация; перерисовка оставила бы один кадр);
 * - PNG — остаётся PNG (скриншоты, текст) без потерь, ≤ 2048 px;
 * - JPEG и всё прочее, что браузер умеет открыть (HEIC в Safari, WebP, BMP), — JPEG ≤ 2048 px, качество 0.85.
 * Перерисовка через canvas заодно срезает метаданные (EXIF: геолокацию, модель телефона).
 */
export async function prepareImage(file: File | Blob, name = (file as File).name || 'image'): Promise<OutgoingAttachment> {
  if (!file.type.startsWith('image/')) throw new AttachError('unsupported', 'Можно отправить только изображение');
  if (file.size > MAX_INPUT_BYTES) throw new AttachError('too_large', 'Файл слишком большой');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AttachError('decode', 'Не удалось открыть изображение');
  }
  try {
    let blob: Blob;
    let outName = name;
    if (file.type === 'image/gif') {
      blob = file;
    } else if (file.type === 'image/png') {
      // Перерисовываем всегда: в PNG бывают метаданные (eXIf, tEXt), они не должны уйти.
      blob = await encode(bitmap, MAX_SIDE, 'image/png');
    } else {
      blob = await encode(bitmap, MAX_SIDE, 'image/jpeg', JPEG_QUALITY);
      outName = withExt(name, 'jpg');
    }
    if (blob.size > MAX_ATTACHMENT_BYTES) throw new AttachError('too_large', 'Файл слишком большой');
    const thumb = await blobToDataUrl(await encode(bitmap, THUMB_SIDE, 'image/jpeg', 0.7));
    return { blob, name: outName, thumb };
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, maxSide: number, type: string, quality?: number): Promise<Blob> {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AttachError('decode', 'Не удалось обработать изображение');
  if (type === 'image/jpeg') {
    // У JPEG нет прозрачности: подкладываем белый, иначе прозрачное станет чёрным.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new AttachError('decode', 'Не удалось обработать изображение'))), type, quality),
  );
}

function withExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return `${base}.${ext}`;
}

/** Маленькое превью картинки для истории (data: URL). */
export async function makeThumb(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    return await blobToDataUrl(await encode(bitmap, THUMB_SIDE, 'image/jpeg', 0.7));
  } finally {
    bitmap.close();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
