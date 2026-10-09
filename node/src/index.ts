/**
 * FaroHQ para Node.js. Sem dependências: usa o fetch nativo (Node 18+).
 * Capturar nunca lança exceção nem atrasa a requisição.
 */

export interface FaroHQOptions {
  /** Chave de ingestão do projeto (farohq_...). Padrão: FAROHQ_KEY. */
  key?: string;
  /** URL de ingestão. Padrão: FAROHQ_ENDPOINT ou a nuvem do FaroHQ. */
  endpoint?: string;
  /** Padrão: FAROHQ_ENV, NODE_ENV ou "production". */
  environment?: string;
  /** SHA do commit do deploy (padrão: GIT_SHA): é com ele que a IA lê o código certo. */
  release?: string;
  /** Nome do serviço que aparece no FaroHQ. */
  service?: string;
  /** Captura uncaughtException/unhandledRejection (padrão: true). */
  captureUnhandled?: boolean;
  /** Desliga o envio sem tirar o código. */
  enabled?: boolean;
}

export type Context = Record<string, string | number | boolean | null | undefined>;

export const DEFAULT_ENDPOINT = "https://api.farohq.com.br/api/v1/ingest/event";

interface Resolved {
  key?: string;
  endpoint: string;
  environment: string;
  release?: string;
  service?: string;
  enabled: boolean;
}

let config: Resolved = resolve({});
const pending = new Set<Promise<void>>();
const captured = new WeakSet<object>();
let handlersInstalled = false;

function resolve(o: FaroHQOptions): Resolved {
  const env = process.env;
  return {
    key: o.key ?? env.FAROHQ_KEY,
    endpoint: o.endpoint ?? env.FAROHQ_ENDPOINT ?? DEFAULT_ENDPOINT,
    environment: o.environment ?? env.FAROHQ_ENV ?? env.NODE_ENV ?? "production",
    release: o.release ?? env.GIT_SHA,
    service: o.service,
    enabled: o.enabled ?? true,
  };
}

/** Configura o FaroHQ. Chame uma vez, no começo da aplicação. */
export function init(options: FaroHQOptions = {}): void {
  config = resolve(options);
  if (options.captureUnhandled !== false && !handlersInstalled) {
    handlersInstalled = true;
    process.on("unhandledRejection", (reason) => {
      captureException(reason, { origin: "unhandledRejection" });
    });
    process.on("uncaughtExceptionMonitor", (error) => {
      // "Monitor" não muda o comportamento padrão do Node (o processo ainda cai)
      captureException(error, { origin: "uncaughtException" });
    });
  }
}

/** Envia uma exceção. Retorna uma promise que nunca rejeita (pode ignorar). */
export function captureException(error: unknown, context?: Context): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  if (captured.has(err)) return Promise.resolve();
  captured.add(err);
  return send({
    message: err.message,
    exception: { type: err.name, message: err.message, stacktrace: err.stack ?? String(err) },
    context,
  });
}

export function captureMessage(message: string, context?: Context): Promise<void> {
  return send({ message, context });
}

/** Espera os envios em andamento (use antes de encerrar processos curtos, ex.: scripts e lambdas). */
export async function flush(timeoutMs = 5000): Promise<void> {
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/**
 * Middleware de erro do Express. Coloque DEPOIS das rotas:
 *   app.use(farohq.expressErrorHandler());
 */
export function expressErrorHandler() {
  return (err: unknown, req: { path?: string; method?: string; originalUrl?: string }, _res: unknown, next: (e: unknown) => void) => {
    captureException(err, { path: req.originalUrl ?? req.path, method: req.method });
    next(err);
  };
}

/**
 * Next.js 15+ (instrumentation.ts):
 *   export { onRequestError } from "@farohq/node";
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routerKind?: string }
): Promise<void> {
  await captureException(err, { path: request.path, method: request.method, route: context?.routePath });
}

function send(payload: { message?: string; exception?: object; context?: Context }): Promise<void> {
  if (!config.enabled || !config.key) return Promise.resolve();
  const body = JSON.stringify({
    level: "error",
    environment: config.environment,
    release: config.release,
    service: config.service,
    timestamp: new Date().toISOString(),
    ...payload,
  });
  const p = fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-FaroHQ-Key": config.key, "User-Agent": "farohq-node/0.1.0" },
    body,
    signal: AbortSignal.timeout(10000),
  })
    .then(() => undefined)
    .catch(() => undefined) // FaroHQ fora do ar: o evento se perde, a aplicação segue
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

export default { init, captureException, captureMessage, flush, expressErrorHandler, onRequestError };
