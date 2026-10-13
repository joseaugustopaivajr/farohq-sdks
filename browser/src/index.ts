/**
 * FaroHQ no navegador. Sem dependências.
 *
 *   import * as farohq from "@farohq/browser";
 *   farohq.init({ publicKey: "farohq_pk_...", release: process.env.NEXT_PUBLIC_GIT_SHA });
 *
 * - Erros de JavaScript e promises rejeitadas, com o que o usuário fez antes (cliques, navegação,
 *   chamadas à API, console).
 * - Liga o front ao back: as chamadas para a sua API levam o header traceparent, e o erro do
 *   navegador aparece junto com o erro e os logs daquela requisição no backend.
 * - Desempenho real das páginas: LCP, INP, CLS, FCP e TTFB, visualizações e sessões.
 *
 * Usa a chave PÚBLICA do projeto (só envia dados e só dos domínios cadastrados no FaroHQ).
 * Nada aqui pode quebrar o site: toda captura é protegida e o envio é em segundo plano.
 */

export interface BrowserOptions {
  /** Chave pública do projeto (farohq_pk_...). Em Configurações do projeto no FaroHQ. */
  publicKey: string;
  /** Padrão: https://api.farohq.com.br/api/v1 */
  endpoint?: string;
  environment?: string;
  /** Versão do deploy (SHA do commit). Precisa ser a mesma do upload dos source maps. */
  release?: string;
  /** Nome que aparece no FaroHQ (padrão: "browser"). */
  service?: string;
  /**
   * Para quais APIs mandar o header traceparent (liga o erro do front ao backend).
   * Padrão: só o mesmo domínio do site. Ex.: ["https://api.minhaloja.com.br", /\.minhaloja\.com\.br/]
   * A API precisa aceitar o header traceparent no CORS.
   */
  tracePropagationTargets?: (string | RegExp)[];
  /** Linhas do que o usuário fez antes do erro (padrão: 30). */
  maxBreadcrumbs?: number;
  /** Guarda console.* no rastro (padrão: true). */
  captureConsole?: boolean;
  /** Envia também o console.* e farohq.log para o módulo de Logs (padrão: false). */
  shipLogs?: boolean;
  /** Mede o desempenho das páginas (padrão: true). */
  rum?: boolean;
  /** Fração das sessões medidas, de 0 a 1 (padrão: 1 = todas). */
  rumSampleRate?: number;
  /** Último filtro antes de enviar um erro: devolva null para descartar. */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  enabled?: boolean;
}

export interface Breadcrumb {
  timestamp: string;
  level: string;
  logger: string;
  message: string;
}

export interface ErrorEvent {
  message: string;
  level: string;
  environment?: string;
  release?: string;
  service?: string;
  timestamp: string;
  url: string;
  exception?: { type: string; message: string; stacktrace: string };
  breadcrumbs?: Breadcrumb[];
  traceId?: string;
  context?: Record<string, unknown>;
}

export const DEFAULT_ENDPOINT = "https://api.farohq.com.br/api/v1";

interface State {
  key: string;
  endpoint: string;
  environment?: string;
  release?: string;
  service: string;
  targets: (string | RegExp)[];
  maxBreadcrumbs: number;
  shipLogs: boolean;
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
}

let state: State | null = null;
const crumbs: Breadcrumb[] = [];
const context: Record<string, unknown> = {};
const recentErrors = new Map<string, number>();
let errorsThisMinute = 0;
let minuteStart = Date.now();
/** Última chamada à API que falhou: o erro que vier logo depois provavelmente é por causa dela. */
let lastFailure: { traceId: string; at: number } | null = null;
let nativeFetch: typeof fetch | null = null;
let installed = false;

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

// ---------------------------------------------------------------- init

export function init(options: BrowserOptions): void {
  if (!isBrowser || options.enabled === false || !options.publicKey) return;
  state = {
    key: options.publicKey,
    endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    environment: options.environment,
    release: options.release,
    service: options.service ?? "browser",
    targets: options.tracePropagationTargets ?? [],
    maxBreadcrumbs: Math.max(0, Math.min(options.maxBreadcrumbs ?? 30, 100)),
    shipLogs: options.shipLogs === true,
    beforeSend: options.beforeSend,
  };
  if (installed) return;
  installed = true;
  nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  safe(installErrorHandlers);
  safe(installClickCrumbs);
  safe(installHistory);
  safe(installFetch);
  safe(installXhr);
  if (options.captureConsole !== false) safe(installConsole);
  if (options.rum !== false && sampled(options.rumSampleRate ?? 1)) safe(startRum);
  safe(() => {
    const flushAll = () => {
      flushRum();
      flushLogs();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAll();
    });
    window.addEventListener("pagehide", flushAll);
  });
}

/** Contexto extra que vai em todo erro (ex.: plano do cliente, feature flag). Evite dados pessoais. */
export function setContext(key: string, value: unknown): void {
  context[key] = value;
}

// ---------------------------------------------------------------- erros

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!state) return;
  safe(() => {
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : safeJson(error));
    if (!allowError(`${err.name}:${err.message}:${(err.stack ?? "").slice(0, 300)}`)) return;
    send({
      message: err.message || err.name,
      level: "error",
      exception: { type: err.name || "Error", message: err.message, stacktrace: err.stack ?? `${err.name}: ${err.message}` },
      extra,
    });
  });
}

export function captureMessage(message: string, extra?: Record<string, unknown>): void {
  if (!state) return;
  safe(() => {
    if (!allowError(`msg:${message}`)) return;
    send({ message, level: "error", extra });
  });
}

function send(e: { message: string; level: string; exception?: ErrorEvent["exception"]; extra?: Record<string, unknown> }) {
  const s = state!;
  const failure = lastFailure && Date.now() - lastFailure.at < 10_000 ? lastFailure.traceId : undefined;
  let event: ErrorEvent | null = {
    message: e.message,
    level: e.level,
    environment: s.environment,
    release: s.release,
    service: s.service,
    timestamp: new Date().toISOString(),
    url: location.href,
    exception: e.exception,
    breadcrumbs: crumbs.slice(),
    traceId: failure,
    context: { ...context, ...(e.extra ?? {}), screen: `${window.innerWidth}x${window.innerHeight}` },
  };
  if (s.beforeSend) event = s.beforeSend(event);
  if (!event) return;
  post("error", event);
}

/** Até 20 erros por minuto e sem repetir o mesmo em 5s: um laço de erro não derruba a cota. */
function allowError(fingerprint: string): boolean {
  const now = Date.now();
  if (now - minuteStart > 60_000) {
    minuteStart = now;
    errorsThisMinute = 0;
  }
  const last = recentErrors.get(fingerprint);
  if (last && now - last < 5_000) return false;
  recentErrors.set(fingerprint, now);
  if (recentErrors.size > 100) recentErrors.clear();
  return ++errorsThisMinute <= 20;
}

function installErrorHandlers() {
  window.addEventListener(
    "error",
    (ev: Event) => {
      const target = ev.target as (Element & { src?: string; href?: string }) | null;
      if (target && target !== (window as unknown) && target instanceof Element) {
        // Imagem, script ou CSS que não carregou: vai para o rastro, não vira erro
        addBreadcrumb(`Falha ao carregar ${target.tagName.toLowerCase()} ${target.src || target.href || ""}`, "WARN", "resource");
        return;
      }
      const e = ev as globalThis.ErrorEvent;
      if (e.error) captureException(e.error);
      else if (e.message && e.message !== "Script error.") captureMessage(e.message);
    },
    true
  );
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    captureException(ev.reason ?? new Error("Promise rejeitada sem motivo"), { origin: "unhandledrejection" });
  });
}

// ---------------------------------------------------------------- rastro (breadcrumbs)

export function addBreadcrumb(message: string, level = "INFO", logger = "app"): void {
  if (!state || state.maxBreadcrumbs === 0) return;
  crumbs.push({ timestamp: new Date().toISOString(), level, logger, message: String(message).slice(0, 1000) });
  if (crumbs.length > state.maxBreadcrumbs) crumbs.splice(0, crumbs.length - state.maxBreadcrumbs);
}

/** "button#pagar.btn 'Finalizar compra'". Nunca lê o valor de campos (senha, cartão...). */
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const label = el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("data-testid");
  const isField = tag === "input" || tag === "textarea" || tag === "select";
  const text = !isField ? (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) : "";
  return `${tag}${id}${cls}${label ? `[${label}]` : ""}${text ? ` '${text}'` : ""}`;
}

function installClickCrumbs() {
  document.addEventListener(
    "click",
    (ev) => {
      let el = ev.target as Element | null;
      // Sobe até o elemento clicável (botão/link), que descreve melhor a ação
      for (let i = 0; el && i < 4; i++) {
        if (el.matches?.("a,button,[role=button],input,select,textarea,label,summary")) break;
        el = el.parentElement;
      }
      if (el) addBreadcrumb(`Clique em ${describe(el)}`, "INFO", "ui.click");
    },
    true
  );
}

function installHistory() {
  let current = location.pathname + location.search;
  const changed = () => {
    const next = location.pathname + location.search;
    if (next === current) return;
    addBreadcrumb(`Navegou de ${stripQuery(current)} para ${stripQuery(next)}`, "INFO", "navigation");
    current = next;
    onRouteChange();
  };
  for (const m of ["pushState", "replaceState"] as const) {
    const original = history[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = original.apply(this, args);
      safe(changed);
      return r;
    } as History["pushState"];
  }
  window.addEventListener("popstate", () => safe(changed));
}

function installConsole() {
  const levels: [keyof Console, string][] = [
    ["debug", "DEBUG"],
    ["log", "INFO"],
    ["info", "INFO"],
    ["warn", "WARN"],
    ["error", "ERROR"],
  ];
  for (const [method, level] of levels) {
    const original = console[method] as (...a: unknown[]) => void;
    if (typeof original !== "function") continue;
    (console as unknown as Record<string, unknown>)[method] = function (this: Console, ...args: unknown[]) {
      safe(() => {
        const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : safeJson(a))).join(" ");
        addBreadcrumb(text, level, "console");
        if (level !== "DEBUG") log(level, text);
      });
      return original.apply(this, args);
    };
  }
}

// ---------------------------------------------------------------- chamadas à API + traceparent

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function shouldTrace(url: string): boolean {
  if (!state) return false;
  let abs: URL;
  try {
    abs = new URL(url, location.href);
  } catch {
    return false;
  }
  if (abs.href.startsWith(state.endpoint)) return false;
  if (abs.origin === location.origin) return true;
  return state.targets.some((t) => (typeof t === "string" ? abs.href.startsWith(t) : t.test(abs.href)));
}

function isOwn(url: string): boolean {
  return !!state && url.startsWith(state.endpoint);
}

function recordRequest(method: string, url: string, status: number, ms: number, traceId?: string) {
  const level = status === 0 || status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";
  addBreadcrumb(`${method} ${stripQuery(url)} → ${status === 0 ? "falhou (rede)" : status} (${Math.round(ms)}ms)`, level, "http");
  if (traceId && (status === 0 || status >= 500)) lastFailure = { traceId, at: Date.now() };
}

function installFetch() {
  if (!window.fetch) return;
  const original = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (typeof input === "object" && "method" in input ? input.method : "GET") || "GET").toUpperCase();
    if (isOwn(url)) return original.call(window, input as RequestInfo, init);
    let traceId: string | undefined;
    let nextInit = init;
    try {
      if (shouldTrace(url)) {
        traceId = hex(16);
        const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
        if (!headers.has("traceparent")) headers.set("traceparent", `00-${traceId}-${hex(8)}-01`);
        nextInit = { ...init, headers };
      }
    } catch {
      nextInit = init;
    }
    const start = performance.now();
    return original.call(window, input as RequestInfo, nextInit).then(
      (res) => {
        safe(() => recordRequest(method, url, res.status, performance.now() - start, traceId));
        return res;
      },
      (err) => {
        safe(() => recordRequest(method, url, 0, performance.now() - start, traceId));
        throw err;
      }
    );
  } as typeof fetch;
}

function installXhr() {
  if (typeof XMLHttpRequest === "undefined") return;
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const sendFn = proto.send;
  type Info = { method: string; url: string; start: number; traceId?: string };
  const info = new WeakMap<XMLHttpRequest, Info>();
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    info.set(this, { method: String(method).toUpperCase(), url: String(url), start: 0 });
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const i = info.get(this);
    if (i && !isOwn(i.url)) {
      safe(() => {
        if (shouldTrace(i.url)) {
          i.traceId = hex(16);
          this.setRequestHeader("traceparent", `00-${i.traceId}-${hex(8)}-01`);
        }
      });
      i.start = performance.now();
      this.addEventListener("loadend", () => safe(() => recordRequest(i.method, i.url, this.status, performance.now() - i.start, i.traceId)));
    }
    return sendFn.call(this, body);
  };
}

// ---------------------------------------------------------------- logs (opcional)

const logQueue: object[] = [];

/** Linha para o módulo de Logs (precisa de shipLogs: true). Vai em lote. */
export function log(level: string, message: string, attributes?: Record<string, unknown>): void {
  if (!state?.shipLogs) return;
  if (logQueue.length >= 1000) return;
  logQueue.push({
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    logger: "browser",
    message: String(message).slice(0, 8000),
    service: state.service,
    environment: state.environment,
    release: state.release,
    traceId: lastFailure && Date.now() - lastFailure.at < 10_000 ? lastFailure.traceId : undefined,
    attributes: { ...attributes, page: location.pathname },
  });
  if (logQueue.length >= 100) flushLogs();
  else scheduleFlush();
}

function flushLogs() {
  if (!logQueue.length) return;
  post("logs", logQueue.splice(0, 200));
}

// ---------------------------------------------------------------- desempenho (RUM)

type RumEvent = { type: "view" | "vital"; ts: string; page: string; metric?: string; value?: number; navType?: string };
const rumQueue: RumEvent[] = [];
let rumOn = false;
let initialPage = "";
let inp: { interactions: Map<number, number>; page: string } = { interactions: new Map(), page: "" };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sessionId(): string {
  try {
    const raw = sessionStorage.getItem("farohq_session");
    const now = Date.now();
    if (raw) {
      const s = JSON.parse(raw) as { id: string; last: number; sampled: boolean };
      if (now - s.last < 30 * 60_000) {
        s.last = now;
        sessionStorage.setItem("farohq_session", JSON.stringify(s));
        return s.id;
      }
    }
    const s = { id: hex(12), last: now, sampled: true };
    sessionStorage.setItem("farohq_session", JSON.stringify(s));
    return s.id;
  } catch {
    return hex(12);
  }
}

function sampled(rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  try {
    const key = "farohq_rum_sampled";
    const v = sessionStorage.getItem(key);
    if (v !== null) return v === "1";
    const yes = Math.random() < rate;
    sessionStorage.setItem(key, yes ? "1" : "0");
    return yes;
  } catch {
    return Math.random() < rate;
  }
}

function rumPush(e: Omit<RumEvent, "ts">) {
  rumQueue.push({ ...e, ts: new Date().toISOString() });
  if (rumQueue.length >= 50) flushRum();
  else scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRum();
    flushLogs();
  }, 10_000);
}

function flushRum() {
  if (!rumOn || !rumQueue.length || !state) return;
  reportInp();
  post("rum", { sessionId: sessionId(), release: state.release, environment: state.environment, events: rumQueue.splice(0, 200) });
}

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, opts: Record<string, unknown> = {}) {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    new PerformanceObserver((list) => safe(() => cb(list.getEntries()))).observe({ type, buffered: true, ...opts } as PerformanceObserverInit);
  } catch {
    // navegador antigo: sem a métrica
  }
}

function startRum() {
  rumOn = true;
  initialPage = location.pathname;
  inp = { interactions: new Map(), page: initialPage };
  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  rumPush({ type: "view", page: initialPage, navType: nav?.type ?? "navigate" });

  // TTFB: até o primeiro byte da página
  if (nav && nav.responseStart > 0) {
    rumPush({ type: "vital", page: initialPage, metric: "TTFB", value: Math.max(0, nav.responseStart - ((nav as PerformanceNavigationTiming & { activationStart?: number }).activationStart || 0)) });
  }
  // FCP: primeira coisa desenhada
  observe("paint", (entries) => {
    for (const e of entries) {
      if (e.name === "first-contentful-paint") rumPush({ type: "vital", page: initialPage, metric: "FCP", value: e.startTime });
    }
  });
  // LCP: o maior elemento visível; vale o último até o usuário interagir ou sair
  let lcp = 0;
  let lcpDone = false;
  observe("largest-contentful-paint", (entries) => {
    const last = entries[entries.length - 1];
    if (last && !lcpDone) lcp = last.startTime;
  });
  const finishLcp = () => {
    if (lcpDone || lcp <= 0) return;
    lcpDone = true;
    rumPush({ type: "vital", page: initialPage, metric: "LCP", value: lcp });
  };
  for (const t of ["keydown", "click", "pointerdown"]) addEventListener(t, () => setTimeout(finishLcp, 0), { once: true, capture: true });
  // CLS: maior "janela" de saltos de layout sem interação do usuário
  let cls = 0;
  let windowValue = 0;
  let windowStart = 0;
  let lastShift = 0;
  observe("layout-shift", (entries) => {
    for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (e.hadRecentInput) continue;
      if (windowValue && e.startTime - lastShift < 1000 && e.startTime - windowStart < 5000) windowValue += e.value;
      else {
        windowValue = e.value;
        windowStart = e.startTime;
      }
      lastShift = e.startTime;
      cls = Math.max(cls, windowValue);
    }
  });
  // INP: a interação mais lenta (clique/tecla até a tela responder)
  observe(
    "event",
    (entries) => {
      for (const e of entries as (PerformanceEntry & { interactionId?: number; duration: number })[]) {
        if (!e.interactionId) continue;
        const prev = inp.interactions.get(e.interactionId) ?? 0;
        if (e.duration > prev) inp.interactions.set(e.interactionId, e.duration);
      }
    },
    { durationThreshold: 40 }
  );
  observe("first-input", (entries) => {
    for (const e of entries as (PerformanceEntry & { processingStart: number })[]) {
      const d = e.processingStart - e.startTime;
      if (!inp.interactions.size) inp.interactions.set(-1, d);
    }
  });
  const onHidden = (ev?: Event) => {
    if (ev?.type !== "pagehide" && document.visibilityState !== "hidden") return;
    finishLcp();
    if (cls > 0 || lcp > 0) rumPush({ type: "vital", page: initialPage, metric: "CLS", value: Number(cls.toFixed(4)) });
    cls = 0;
    windowValue = 0;
  };
  document.addEventListener("visibilitychange", onHidden, true);
  // pagehide vem antes do flush geral (registrado no init), então o CLS vai no mesmo envio
  window.addEventListener("pagehide", onHidden, true);
}

/** INP ≈ a pior interação (ignorando 1 a cada 50, como o Chrome) da página atual. */
function reportInp() {
  if (!inp.interactions.size) return;
  const d = Array.from(inp.interactions.values()).sort((a, b) => b - a);
  const value = d[Math.min(d.length - 1, Math.floor(d.length / 50))];
  rumQueue.push({ type: "vital", ts: new Date().toISOString(), page: inp.page, metric: "INP", value });
  inp.interactions.clear();
}

function onRouteChange() {
  if (!rumOn) return;
  reportInp();
  inp = { interactions: new Map(), page: location.pathname };
  rumPush({ type: "view", page: location.pathname, navType: "route" });
}

// ---------------------------------------------------------------- envio

function post(kind: "error" | "rum" | "logs", body: unknown) {
  if (!state) return;
  const url = `${state.endpoint}/ingest/browser/${kind}?key=${encodeURIComponent(state.key)}`;
  let data: string;
  try {
    data = JSON.stringify(body);
  } catch {
    return;
  }
  safe(() => {
    // sendBeacon sobrevive ao fechamento da aba; text/plain evita a pré-checagem de CORS
    if (navigator.sendBeacon && data.length < 60_000 && navigator.sendBeacon(url, new Blob([data], { type: "text/plain" }))) return;
    const f = nativeFetch ?? window.fetch;
    void f(url, { method: "POST", body: data, keepalive: data.length < 60_000, headers: { "Content-Type": "text/plain" } }).catch(() => undefined);
  });
}

/** Manda na hora o que estiver na fila (ex.: antes de um redirect manual). */
export function flush(): void {
  flushRum();
  flushLogs();
}

// ---------------------------------------------------------------- utilidades

function safe(fn: () => void) {
  try {
    fn();
  } catch {
    // nunca quebra o site
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v).slice(0, 1000) : String(v);
  } catch {
    return String(v);
  }
}

function stripQuery(u: string): string {
  return u.replace(/[?#].*$/, "");
}

export default { init, captureException, captureMessage, addBreadcrumb, setContext, log, flush };
