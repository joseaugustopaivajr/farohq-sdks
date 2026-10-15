"""FaroHQ para Python: envia os erros da aplicação para análise de causa raiz.

Uso:
    import farohq
    farohq.init(service="minha-api")   # chave em FAROHQ_KEY

Tudo que for logado com nível ERROR (inclusive as exceções não tratadas do Django, Flask
e FastAPI/uvicorn) vira evento. Sem dependências; o envio acontece numa thread de fundo
e nunca derruba a aplicação.
"""

from __future__ import annotations

import atexit
import contextlib
import contextvars
import json
import logging
import os
import queue
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, Iterator, List, Optional

__all__ = [
    "init",
    "capture_exception",
    "capture_message",
    "add_breadcrumb",
    "log",
    "scope",
    "flush",
    "FaroHQHandler",
    "FaroHQWSGIMiddleware",
    "FaroHQASGIMiddleware",
]
__version__ = "0.2.1"

DEFAULT_ENDPOINT = "https://api.farohq.com.br/api/v1/ingest/event"
_GLOBAL_MAX_AGE = 300.0  # fora de um scope, só linhas dos últimos 5 minutos


class _Scope:
    __slots__ = ("trace_id", "crumbs")

    def __init__(self, trace_id: Optional[str], size: int):
        self.trace_id = trace_id
        self.crumbs: Deque[Dict[str, Any]] = deque(maxlen=max(size, 1))


# Rastro da requisição atual (vale para threads e para asyncio); fora dela, um rastro por thread.
_current: "contextvars.ContextVar[Optional[_Scope]]" = contextvars.ContextVar("farohq_scope", default=None)
_thread = threading.local()


class _Client:
    def __init__(self, key, endpoint, environment, release, service, enabled, queue_size, max_breadcrumbs=30,
                 ship_logs=False):
        self.key = key
        self.endpoint = endpoint
        self.environment = environment
        self.release = release
        self.service = service
        self.enabled = enabled
        self.max_breadcrumbs = max(0, min(max_breadcrumbs, 100))
        self._queue: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=queue_size)
        self._seen: "set[int]" = set()
        self._rejected = False  # chave recusada (401): para de enviar
        self._warned: "set[str]" = set()
        self._worker = threading.Thread(target=self._loop, name="farohq-sender", daemon=True)
        self._worker.start()
        if self.can_send() and (endpoint or "").rstrip("/").endswith("/ingest/event"):
            threading.Thread(target=self._verify, name="farohq-verify", daemon=True).start()
        self.ship_logs = bool(ship_logs) and self.can_send()
        self._logs: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=10_000)
        self._logs_endpoint = (endpoint or "").rstrip("/")
        if self._logs_endpoint.endswith("/ingest/event"):
            self._logs_endpoint = self._logs_endpoint[: -len("/ingest/event")] + "/ingest/logs"
        if self.ship_logs:
            threading.Thread(target=self._logs_loop, name="farohq-logs", daemon=True).start()

    def log(self, level: str, message: str, logger: Optional[str], trace_id: Optional[str],
            attributes: Optional[Dict[str, Any]] = None):
        """Uma linha para o módulo de Logs (em lote, a cada 2s). Fila cheia descarta."""
        if not self.ship_logs:
            return
        s = _current.get()
        line = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "logger": logger,
            "message": str(message)[:32_000],
            "service": self.service,
            "environment": self.environment,
            "release": self.release,
            "traceId": trace_id or (s.trace_id if s is not None else None),
        }
        if attributes:
            line["attributes"] = {str(k): (v if isinstance(v, (int, float, bool)) or v is None else str(v))
                                  for k, v in attributes.items()}
        try:
            self._logs.put_nowait(line)
        except queue.Full:
            pass

    def _logs_loop(self):
        while True:
            first = self._logs.get()
            batch = [first]
            deadline = time.time() + 2.0
            while len(batch) < 500:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                try:
                    batch.append(self._logs.get(timeout=remaining))
                except queue.Empty:
                    break
            try:
                if not self._rejected:
                    self._post(self._logs_endpoint, json.dumps(batch).encode("utf-8"))
            finally:
                for _ in batch:
                    self._logs.task_done()

    def _post(self, url: str, data: bytes):
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Content-Type": "application/json",
            "X-FaroHQ-Key": self.key,
            "User-Agent": "farohq-python/" + __version__,
        })
        try:
            urllib.request.urlopen(req, timeout=10).close()
        except urllib.error.HTTPError as e:
            self._refused(e)
        except Exception:
            pass  # FaroHQ fora do ar: o dado se perde, a aplicação segue

    def _verify(self):
        """Confere a chave ao iniciar: sem isso, uma chave errada só apareceria (ou não) no primeiro erro."""
        url = self.endpoint.rstrip("/")[: -len("/ingest/event")] + "/ingest/ping"
        req = urllib.request.Request(url, method="GET", headers={
            "X-FaroHQ-Key": self.key,
            "User-Agent": "farohq-python/" + __version__,
        })
        try:
            urllib.request.urlopen(req, timeout=5).close()
        except urllib.error.HTTPError as e:
            self._refused(e)
        except Exception as e:  # noqa: BLE001
            self._warn("net", "Não foi possível falar com o FaroHQ ({}): {}.".format(url, e))

    def _refused(self, e: "urllib.error.HTTPError"):
        """Recusa do FaroHQ não passa em silêncio: aparece uma vez no stderr com o motivo."""
        if e.code >= 500:
            return
        reason = ""
        try:
            reason = json.loads(e.read().decode("utf-8")).get("message") or ""
        except Exception:  # noqa: BLE001
            pass
        why = ": " + reason if reason else ""
        if e.code == 401:
            self._rejected = True
            self._warn("401", "Chave recusada (401){}. Nada está sendo enviado ao FaroHQ.".format(why))
        elif e.code == 403:
            self._warn("403", "Envio recusado (403){}.".format(why))
        elif e.code == 404:
            self._warn("404", "Endereço do FaroHQ não encontrado (404): confira FAROHQ_ENDPOINT ({}).".format(self.endpoint))
        elif e.code == 429:
            self._warn("429", "Limite atingido (429){}. Parte dos dados está sendo descartada.".format(why))

    def _warn(self, code: str, message: str):
        # Direto no stderr: o logging está capturado e o aviso não pode virar log enviado (nem erro)
        if code in self._warned:
            return
        self._warned.add(code)
        try:
            sys.stderr.write("[FaroHQ] " + message + "\n")
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass

    def can_send(self) -> bool:
        return bool(self.enabled and self.key and self.endpoint)

    def add_breadcrumb(self, message: str, level: str, logger: Optional[str], trace_id: Optional[str] = None):
        if self.max_breadcrumbs <= 0:
            return
        s = _current.get()
        if s is None:
            s = getattr(_thread, "scope", None)
            if s is None or s.crumbs.maxlen != self.max_breadcrumbs or (trace_id and trace_id != s.trace_id):
                s = _thread.scope = _Scope(trace_id, self.max_breadcrumbs)
        s.crumbs.append({"ts": time.time(), "level": level, "logger": logger, "message": str(message)[:1000]})

    def _breadcrumbs(self, trace_id: Optional[str]) -> List[Dict[str, Any]]:
        s = _current.get()
        cutoff = 0.0
        if s is None:
            s = getattr(_thread, "scope", None)
            cutoff = time.time() - _GLOBAL_MAX_AGE
            if s is None or (trace_id and s.trace_id and trace_id != s.trace_id):
                return []
        return [
            {
                "timestamp": datetime.fromtimestamp(c["ts"], timezone.utc).isoformat(),
                "level": c["level"],
                "logger": c["logger"],
                "message": c["message"],
            }
            for c in list(s.crumbs)
            if c["ts"] >= cutoff
        ]

    def capture(
        self,
        message: Optional[str],
        exc: Optional[BaseException],
        context: Optional[Dict[str, Any]],
        trace_id: Optional[str] = None,
    ):
        if not self.can_send():
            return
        try:
            if exc is not None:
                if id(exc) in self._seen:
                    return
                self._seen.add(id(exc))
                if len(self._seen) > 10_000:
                    self._seen.clear()
            body: Dict[str, Any] = {
                "level": "error",
                "environment": self.environment,
                "release": self.release,
                "service": self.service,
                "message": message if message is not None else (str(exc) if exc else None),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if exc is not None:
                body["exception"] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "stacktrace": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
                }
            s = _current.get()
            trace_id = trace_id or (s.trace_id if s is not None else None)
            if trace_id:
                body["traceId"] = str(trace_id)[:100]
            if self.max_breadcrumbs > 0:
                crumbs = self._breadcrumbs(trace_id)
                if crumbs:
                    body["breadcrumbs"] = crumbs
            if context:
                body["context"] = {str(k): (None if v is None else str(v)) for k, v in context.items()}
            self._queue.put_nowait(json.dumps(body).encode("utf-8"))
        except Exception:
            pass  # reportar nunca pode derrubar a aplicação

    def _loop(self):
        while True:
            data = self._queue.get()
            try:
                if data is None:
                    return
                if not self._rejected:
                    self._post(self.endpoint, data)
            finally:
                self._queue.task_done()

    def flush(self, timeout: float = 5.0):
        done = threading.Event()

        def wait():
            self._queue.join()
            if self.ship_logs:
                self._logs.join()
            done.set()

        threading.Thread(target=wait, daemon=True).start()
        done.wait(timeout)


_client: Optional[_Client] = None


_TRACE_ATTRS = ("otelTraceID", "trace_id", "traceId", "request_id", "correlation_id")


def _record_trace_id(record: logging.LogRecord) -> Optional[str]:
    for attr in _TRACE_ATTRS:
        v = getattr(record, attr, None)
        if v and v != "0":
            return str(v)
    return None


class FaroHQHandler(logging.Handler):
    """Handler de logging: ERROR ou maior vira evento; as linhas abaixo (a partir de
    breadcrumb_level) ficam no rastro e vão junto com o próximo erro."""

    def __init__(self, level: int = logging.ERROR, breadcrumb_level: int = logging.INFO,
                 logs_level: int = logging.INFO):
        super().__init__(level=min(level, breadcrumb_level, logs_level))
        self.event_level = level
        self.breadcrumb_level = breadcrumb_level
        self.logs_level = logs_level

    def emit(self, record: logging.LogRecord) -> None:
        if _client is None or record.name.startswith("farohq") or record.name.startswith("urllib3"):
            return
        trace_id = _record_trace_id(record)
        if _client.ship_logs and record.levelno >= self.logs_level:
            try:
                msg = record.getMessage()
                if record.exc_info and record.exc_info[1] is not None:
                    msg += "\n" + type(record.exc_info[1]).__name__ + ": " + str(record.exc_info[1])
                _client.log(record.levelname, msg, record.name, trace_id)
            except Exception:
                pass
        if record.levelno < self.event_level:
            if record.levelno >= self.breadcrumb_level:
                try:
                    _client.add_breadcrumb(record.getMessage(), record.levelname, record.name, trace_id)
                except Exception:
                    pass
            return
        exc = record.exc_info[1] if record.exc_info else None
        context = {"logger": record.name, "module": record.module}
        request = getattr(record, "request", None)  # Django anexa a requisição em django.request
        if request is not None:
            context["path"] = getattr(request, "path", None)
            context["method"] = getattr(request, "method", None)
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        _client.capture(message, exc, context, trace_id)


def init(
    key: Optional[str] = None,
    endpoint: Optional[str] = None,
    environment: Optional[str] = None,
    release: Optional[str] = None,
    service: Optional[str] = None,
    enabled: bool = True,
    capture_logging: bool = True,
    capture_unhandled: bool = True,
    queue_size: int = 1000,
    max_breadcrumbs: int = 30,
    breadcrumb_level: int = logging.INFO,
    ship_logs: Optional[bool] = None,
    logs_level: int = logging.INFO,
) -> None:
    """Configura o FaroHQ. Chame uma vez, no começo da aplicação (settings.py, app.py, main.py)."""
    global _client
    _client = _Client(
        key=key or os.environ.get("FAROHQ_KEY"),
        endpoint=endpoint or os.environ.get("FAROHQ_ENDPOINT") or DEFAULT_ENDPOINT,
        environment=environment or os.environ.get("FAROHQ_ENV") or "production",
        release=release or os.environ.get("GIT_SHA"),
        service=service,
        enabled=enabled,
        queue_size=queue_size,
        max_breadcrumbs=max_breadcrumbs,
        ship_logs=ship_logs if ship_logs is not None else os.environ.get("FAROHQ_LOGS") == "true",
    )
    if capture_logging:
        root = logging.getLogger()
        for h in [h for h in root.handlers if isinstance(h, FaroHQHandler)]:
            root.removeHandler(h)
        root.addHandler(FaroHQHandler(breadcrumb_level=breadcrumb_level, logs_level=logs_level))
    if capture_unhandled:
        previous = sys.excepthook

        def hook(exc_type, exc, tb):
            capture_exception(exc, {"origin": "uncaught"})
            flush(3)
            previous(exc_type, exc, tb)

        sys.excepthook = hook
    atexit.register(flush, 3)


def capture_exception(exc: Optional[BaseException] = None, context: Optional[Dict[str, Any]] = None) -> None:
    """Envia uma exceção (sem argumento, usa a que está sendo tratada no except)."""
    if exc is None:
        exc = sys.exc_info()[1]
    if _client is not None and exc is not None:
        _client.capture(None, exc, context)


def capture_message(message: str, context: Optional[Dict[str, Any]] = None) -> None:
    if _client is not None:
        _client.capture(message, None, context)


def flush(timeout: float = 5.0) -> None:
    """Espera os envios pendentes (útil em scripts e jobs curtos)."""
    if _client is not None:
        _client.flush(timeout)


def add_breadcrumb(message: str, level: str = "INFO", logger: Optional[str] = None) -> None:
    """Guarda uma linha no rastro da requisição atual; vai junto com o próximo erro."""
    if _client is not None:
        _client.add_breadcrumb(message, level, logger)


@contextlib.contextmanager
def scope(trace_id: Optional[str] = None) -> Iterator[None]:
    """Abre um rastro próprio (uma requisição, um job). O trace_id liga o erro aos logs na sua
    ferramenta (Datadog, Grafana...)."""
    size = _client.max_breadcrumbs if _client is not None else 30
    token = _current.set(_Scope(trace_id, size))
    try:
        yield
    finally:
        _current.reset(token)


def trace_id_from_headers(headers: Dict[str, str]) -> Optional[str]:
    """traceparent (W3C), X-Request-Id, X-Correlation-Id ou X-Amzn-Trace-Id. Chaves em minúsculas."""
    tp = headers.get("traceparent")
    if tp:
        parts = tp.split("-")
        if len(parts) >= 3 and len(parts[1]) == 32:
            return parts[1]
    return headers.get("x-request-id") or headers.get("x-correlation-id") or headers.get("x-amzn-trace-id")


class FaroHQWSGIMiddleware:
    """Um rastro por requisição em apps WSGI (Django, Flask):
    app.wsgi_app = FaroHQWSGIMiddleware(app.wsgi_app)"""

    def __init__(self, app):
        self.app = app

    def __call__(self, environ, start_response):
        headers = {
            k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")
        }
        with scope(trace_id_from_headers(headers)):
            return self.app(environ, start_response)


class FaroHQASGIMiddleware:
    """Um rastro por requisição em apps ASGI (FastAPI, Starlette):
    app.add_middleware(FaroHQASGIMiddleware)"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope_, receive, send):
        if scope_.get("type") not in ("http", "websocket"):
            return await self.app(scope_, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope_.get("headers", [])}
        with scope(trace_id_from_headers(headers)):
            return await self.app(scope_, receive, send)


def log(level: str, message: str, attributes: Optional[Dict[str, Any]] = None, logger: Optional[str] = None) -> None:
    """Envia uma linha estruturada para o módulo de Logs (precisa de ship_logs=True)."""
    if _client is not None:
        _client.log(level.upper(), message, logger, None, attributes)
