import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

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
  /** SHA do commit do deploy (padrão: GIT_SHA): é com ele que o FaroHQ lê o código certo. */
  release?: string;
  /** Nome do serviço que aparece no FaroHQ. */
  service?: string;
  /** Captura uncaughtException/unhandledRejection (padrão: true). */
  captureUnhandled?: boolean;
  /** Desliga o envio sem tirar o código. */
  enabled?: boolean;
  /** Quantas linhas de log anteriores ao erro vão junto (0 desliga). Padrão: 30. */
  maxBreadcrumbs?: number;
  /** Guarda console.log/info/warn/error/debug no rastro (padrão: true). */
  captureConsole?: boolean;
  /**
   * Envia também todos os logs (console e farohq.log) para o módulo de Logs do FaroHQ.
   * Padrão: FAROHQ_LOGS=true ou desligado.
   */
  shipLogs?: boolean;
  /** Nível mínimo das linhas enviadas ao módulo de Logs (padrão: INFO). */
  logsLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export interface Breadcrumb {
  timestamp: string;
  level: string;
  logger?: string;
  message: string;
}

interface Scope {
  traceId?: string;
  crumbs: Breadcrumb[];
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
  maxBreadcrumbs: number;
  shipLogs: boolean;
  logsLevel: number;
}

const LEVEL_RANK: Record<string, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };
let config: Resolved = resolve({});
const logQueue: object[] = [];
let logTimer: NodeJS.Timeout | null = null;
const LOG_BATCH = 500;
const LOG_QUEUE_MAX = 10_000;
const pending = new Set<Promise<void>>();
const captured = new WeakSet<object>();
let handlersInstalled = false;
let consolePatched = false;
/** Avisos já mostrados (cada problema aparece uma vez só) e chave recusada (para de tentar). */
const warned = new Set<string>();
let keyRejected = false;
const USER_AGENT = "farohq-node/0.2.1";
/** Rastro por requisição (AsyncLocalStorage); fora de uma requisição, um rastro global. */
const scopes = new AsyncLocalStorage<Scope>();
const globalScope: Scope = { crumbs: [] };
const GLOBAL_MAX_AGE_MS = 5 * 60 * 1000;

function resolve(o: FaroHQOptions): Resolved {
  const env = process.env;
  return {
    key: o.key ?? env.FAROHQ_KEY,
    endpoint: o.endpoint ?? env.FAROHQ_ENDPOINT ?? DEFAULT_ENDPOINT,
    environment: o.environment ?? env.FAROHQ_ENV ?? env.NODE_ENV ?? "production",
    release: o.release ?? env.GIT_SHA,
    service: o.service,
    enabled: o.enabled ?? true,
    maxBreadcrumbs: Math.max(0, Math.min(o.maxBreadcrumbs ?? 30, 100)),
    shipLogs: o.shipLogs ?? env.FAROHQ_LOGS === "true",
    logsLevel: LEVEL_RANK[o.logsLevel ?? "INFO"],
  };
}

/** Configura o FaroHQ. Chame uma vez, no começo da aplicação. */
export function init(options: FaroHQOptions = {}): void {
  config = resolve(options);
  keyRejected = false;
  if (config.enabled && !config.key && process.env.NODE_ENV === "production") {
    warnOnce("nokey", "FAROHQ_KEY não definida: nenhum erro ou log será enviado ao FaroHQ.");
  }
  if (config.enabled && config.key) void verifyKey();
  if (options.captureConsole !== false && !consolePatched) {
    consolePatched = true;
    patchConsole();
  }
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

/**
 * Envia uma linha para o módulo de Logs (se shipLogs estiver ligado). Vai em lote, a cada 2s.
 * O console já é enviado sozinho; use para logs estruturados com atributos.
 */
export function log(level: string, message: string, attributes?: Record<string, unknown>, logger?: string): void {
  if (!config.shipLogs || !config.enabled || !config.key) return;
  const lvl = level.toUpperCase();
  if ((LEVEL_RANK[lvl] ?? 2) < config.logsLevel) return;
  if (logQueue.length >= LOG_QUEUE_MAX) return; // fila cheia: descarta, nunca segura a aplicação
  logQueue.push({
    timestamp: new Date().toISOString(),
    level: lvl,
    logger,
    message: String(message).slice(0, 32_000),
    service: config.service,
    environment: config.environment,
    release: config.release,
    traceId: scopes.getStore()?.traceId,
    attributes,
  });
  if (logQueue.length >= LOG_BATCH) void shipLogs();
  else if (!logTimer) {
    logTimer = setTimeout(() => void shipLogs(), 2000);
    logTimer.unref?.();
  }
}

function shipLogs(): Promise<void> {
  if (logTimer) {
    clearTimeout(logTimer);
    logTimer = null;
  }
  if (!logQueue.length || !config.key || keyRejected) {
    if (keyRejected) logQueue.length = 0;
    return Promise.resolve();
  }
  const batch = logQueue.splice(0, LOG_BATCH);
  const url = config.endpoint.replace(/\/ingest\/event\/?$/, "/ingest/logs");
  const p = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-FaroHQ-Key": config.key, "User-Agent": USER_AGENT },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(10000),
  })
    .then(checkResponse)
    .catch(() => undefined)
    .finally(() => {
      pending.delete(p);
      if (logQueue.length) void shipLogs();
    });
  pending.add(p);
  return p;
}

/** Guarda uma linha no rastro da requisição atual; vai junto com o próximo erro. */
export function addBreadcrumb(message: string, level = "INFO", logger?: string): void {
  if (config.maxBreadcrumbs <= 0) return;
  const scope = scopes.getStore() ?? globalScope;
  scope.crumbs.push({ timestamp: new Date().toISOString(), level, logger, message: String(message).slice(0, 1000) });
  if (scope.crumbs.length > config.maxBreadcrumbs) scope.crumbs.splice(0, scope.crumbs.length - config.maxBreadcrumbs);
}

/**
 * Roda fn com um rastro próprio (uma requisição, um job). Os logs e o erro lá dentro ficam juntos
 * e levam o traceId, que liga o erro aos logs na sua ferramenta (Datadog, Grafana...).
 */
export function withScope<T>(fn: () => T, traceId?: string): T {
  return scopes.run({ traceId, crumbs: [] }, fn);
}

/** ID da requisição atual, se houver. */
export function currentTraceId(): string | undefined {
  return scopes.getStore()?.traceId;
}

/**
 * Middleware do Express que abre um rastro por requisição. Coloque ANTES das rotas:
 *   app.use(farohq.expressRequestHandler());
 * O traceId vem dos cabeçalhos traceparent, x-request-id ou x-amzn-trace-id.
 */
export function expressRequestHandler() {
  return (req: { headers?: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
    withScope(next, traceIdFromHeaders(req.headers ?? {}));
  };
}

export function traceIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tp = one(headers["traceparent"]);
  if (tp) {
    const parts = tp.split("-");
    if (parts.length >= 3 && parts[1].length === 32) return parts[1];
  }
  return one(headers["x-request-id"]) ?? one(headers["x-correlation-id"]) ?? one(headers["x-amzn-trace-id"]);
}

function currentCrumbs(): { traceId?: string; breadcrumbs?: Breadcrumb[] } {
  const scope = scopes.getStore();
  if (scope) return { traceId: scope.traceId, breadcrumbs: scope.crumbs.length ? [...scope.crumbs] : undefined };
  const cutoff = Date.now() - GLOBAL_MAX_AGE_MS;
  const recent = globalScope.crumbs.filter((c) => Date.parse(c.timestamp) >= cutoff);
  return { breadcrumbs: recent.length ? recent : undefined };
}

function patchConsole(): void {
  const levels: Array<[keyof Console, string]> = [
    ["debug", "DEBUG"],
    ["log", "INFO"],
    ["info", "INFO"],
    ["warn", "WARN"],
    ["error", "ERROR"],
  ];
  for (const [method, level] of levels) {
    const original = console[method] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    (console as unknown as Record<string, unknown>)[method] = function (this: Console, ...args: unknown[]) {
      try {
        const text = format(...args);
        addBreadcrumb(text, level, "console");
        log(level, text, undefined, "console");
      } catch {
        // nunca atrapalha o log
      }
      return original.apply(this, args);
    };
  }
}

/** Espera os envios em andamento (use antes de encerrar processos curtos, ex.: scripts e lambdas). */
export async function flush(timeoutMs = 5000): Promise<void> {
  if (logQueue.length) void shipLogs();
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
 *   export { onRequestError } from "@farohqbr/node";
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routerKind?: string }
): Promise<void> {
  await captureException(err, { path: request.path, method: request.method, route: context?.routePath });
}

function send(payload: { message?: string; exception?: object; context?: Context }): Promise<void> {
  if (!config.enabled || !config.key || keyRejected) return Promise.resolve();
  const body = JSON.stringify({
    level: "error",
    environment: config.environment,
    release: config.release,
    service: config.service,
    timestamp: new Date().toISOString(),
    ...(config.maxBreadcrumbs > 0 ? currentCrumbs() : {}),
    ...payload,
  });
  const p = fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-FaroHQ-Key": config.key, "User-Agent": USER_AGENT },
    body,
    signal: AbortSignal.timeout(10000),
  })
    .then(checkResponse)
    .catch(() => undefined) // FaroHQ fora do ar: o evento se perde, a aplicação segue
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

/** Escreve direto no stderr: o console está interceptado e o aviso não pode virar log enviado. */
function warnOnce(code: string, message: string) {
  if (warned.has(code)) return;
  warned.add(code);
  try {
    process.stderr.write(`[FaroHQ] ${message}\n`);
  } catch {
    // sem stderr: nada a fazer
  }
}

/**
 * Recusa do FaroHQ não pode passar em silêncio: chave errada, domínio/conta bloqueados, cota ou
 * endereço errado aparecem uma vez no log. Com a chave recusada (401), o SDK para de enviar.
 */
async function checkResponse(res: Response): Promise<void> {
  if (res.ok || res.status >= 500) return;
  let reason = "";
  try {
    reason = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    // corpo sem JSON
  }
  const why = reason ? `: ${reason}` : "";
  if (res.status === 401) {
    keyRejected = true;
    warnOnce("401", `Chave recusada (401)${why}. Nada está sendo enviado ao FaroHQ.`);
  } else if (res.status === 403) {
    warnOnce("403", `Envio recusado (403)${why}.`);
  } else if (res.status === 404) {
    warnOnce("404", `Endereço do FaroHQ não encontrado (404): confira FAROHQ_ENDPOINT (${config.endpoint}).`);
  } else if (res.status === 429) {
    warnOnce("429", `Limite atingido (429)${why}. Parte dos dados está sendo descartada.`);
  }
}

/** Confere a chave ao iniciar: sem isso, uma chave errada só apareceria (ou não) no primeiro erro. */
function verifyKey(): Promise<void> {
  // Só com o endereço padrão de eventos dá para saber onde fica a verificação
  if (!/\/ingest\/event\/?$/.test(config.endpoint)) return Promise.resolve();
  const url = config.endpoint.replace(/\/ingest\/event\/?$/, "/ingest/ping");
  const p = fetch(url, {
    headers: { "X-FaroHQ-Key": config.key ?? "", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(5000),
  })
    .then(checkResponse)
    .catch((e: unknown) => {
      warnOnce("net", `Não foi possível falar com o FaroHQ (${url}): ${e instanceof Error ? e.message : String(e)}.`);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

export default {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  log,
  withScope,
  currentTraceId,
  flush,
  expressRequestHandler,
  expressErrorHandler,
  onRequestError,
};
