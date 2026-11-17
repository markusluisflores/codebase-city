import { errorMessage, errorStatus, type ErrorCode } from '@/lib/errors';

const NO_STORE = { 'cache-control': 'no-store' };

/** A JSON error carrying a fixed code and its fixed message, never anything from the failure itself. */
export function apiError(code: ErrorCode, headers: Record<string, string> = {}): Response {
  return Response.json(
    { error: code, message: errorMessage(code) },
    { status: errorStatus(code), headers: { ...NO_STORE, ...headers } },
  );
}

export function apiJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const CHUNK = 64 * 1024;

/**
 * A JSON envelope whose `analysis` can be megabytes, sent as a stream (no Content-Length), because
 * Vercel caps a NON-streamed function response at 4.5 MB and an Analysis may be up to 8 MB.
 */
export function streamEnvelope(
  meta: { source: 'gallery' | 'live'; analysedAt: string | null },
  analysis: unknown,
  headers: Record<string, string>,
): Response {
  const body = new TextEncoder().encode(
    `{"source":${JSON.stringify(meta.source)},"analysedAt":${JSON.stringify(meta.analysedAt)},"analysis":${JSON.stringify(analysis)}}`,
  );
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= body.length) return controller.close();
      controller.enqueue(body.subarray(at, at + CHUNK));
      at += CHUNK;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
