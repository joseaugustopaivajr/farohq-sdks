"""FaroHQ para Python: envia os erros da aplicação para análise de causa raiz com IA.

Uso:
    import farohq
    farohq.init(service="minha-api")   # chave em FAROHQ_KEY

Tudo que for logado com nível ERROR (inclusive as exceções não tratadas do Django, Flask
e FastAPI/uvicorn) vira evento. Sem dependências; o envio acontece numa thread de fundo
e nunca derruba a aplicação.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import sys
import threading
import traceback
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Optional

__all__ = ["init", "capture_exception", "capture_message", "flush", "FaroHQHandler"]
__version__ = "0.1.0"

DEFAULT_ENDPOINT = "https://api.farohq.com.br/api/v1/ingest/event"


class _Client:
    def __init__(self, key, endpoint, environment, release, service, enabled, queue_size):
        self.key = key
        self.endpoint = endpoint
        self.environment = environment
        self.release = release
        self.service = service
        self.enabled = enabled
        self._queue: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=queue_size)
        self._seen: "set[int]" = set()
        self._worker = threading.Thread(target=self._loop, name="farohq-sender", daemon=True)
        self._worker.start()

    def can_send(self) -> bool:
        return bool(self.enabled and self.key and self.endpoint)

    def capture(self, message: Optional[str], exc: Optional[BaseException], context: Optional[Dict[str, Any]]):
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
                req = urllib.request.Request(
                    self.endpoint,
                    data=data,
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        "X-FaroHQ-Key": self.key,
                        "User-Agent": "farohq-python/" + __version__,
                    },
                )
                urllib.request.urlopen(req, timeout=10).close()
            except Exception:
                pass  # FaroHQ fora do ar: o evento se perde, a aplicação segue
            finally:
                self._queue.task_done()

    def flush(self, timeout: float = 5.0):
        done = threading.Event()

        def wait():
            self._queue.join()
            done.set()

        threading.Thread(target=wait, daemon=True).start()
        done.wait(timeout)


_client: Optional[_Client] = None


class FaroHQHandler(logging.Handler):
    """Handler de logging: registros com nível ERROR ou maior viram eventos no FaroHQ."""

    def __init__(self, level: int = logging.ERROR):
        super().__init__(level=level)

    def emit(self, record: logging.LogRecord) -> None:
        if _client is None or record.name.startswith("farohq") or record.name.startswith("urllib3"):
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
        _client.capture(message, exc, context)


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
    )
    if capture_logging:
        root = logging.getLogger()
        if not any(isinstance(h, FaroHQHandler) for h in root.handlers):
            root.addHandler(FaroHQHandler())
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
