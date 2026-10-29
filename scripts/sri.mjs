// Значение для атрибута integrity собранного файла: npm run build && npm run sri
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = new URL('../dist/avai-chat.js', import.meta.url);
const hash = createHash('sha384').update(readFileSync(file)).digest('base64');
console.log(`sha384-${hash}`);
