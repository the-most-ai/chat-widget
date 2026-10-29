import type { IncomingMessage, ServerResponse } from 'node:http';
export const HELP: string;
export function gatewayMiddleware(opts?: {
  prefix?: string;
  allowOrigin?: (origin: string) => boolean;
}): (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;
