import json
import logging
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import farohq  # noqa: E402

RECEIVED = []


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        RECEIVED.append({"key": self.headers.get("X-FaroHQ-Key"), "path": self.path, "body": json.loads(body)})
        self.send_response(202)
        self.end_headers()

    def do_GET(self):  # verificação da chave ao iniciar
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass


class _Refuses(BaseHTTPRequestHandler):
    hits = []

    def _refuse(self):
        _Refuses.hits.append(self.command + " " + self.path)
        body = json.dumps({"status": 401, "message": "Chave de projeto inválida"}).encode("utf-8")
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._refuse()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._refuse()

    def log_message(self, *args):
        pass


class ChaveRecusadaTest(unittest.TestCase):
    def test_avisa_uma_vez_e_para_de_enviar(self):
        import io
        import time
        server = HTTPServer(("127.0.0.1", 0), _Refuses)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/api/v1/ingest/event" % server.server_address[1]
        err, sys.stderr = sys.stderr, io.StringIO()
        try:
            farohq.init(key="farohq_errada", endpoint=url, capture_unhandled=False, capture_logging=False)
            for _ in range(50):
                if _Refuses.hits:
                    break
                time.sleep(0.05)
            time.sleep(0.1)
            farohq.capture_message("depois da recusa")
            farohq.flush(2)
            out = sys.stderr.getvalue()
        finally:
            sys.stderr = err
            server.shutdown()
        self.assertEqual(_Refuses.hits, ["GET /api/v1/ingest/ping"])
        self.assertEqual(out.count("[FaroHQ]"), 1, out)
        self.assertIn("Chave recusada (401): Chave de projeto inválida", out)


class FaroHQTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d/ingest/event" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        RECEIVED.clear()
        farohq.init(key="farohq_teste", endpoint=self.url, service="loja", release="abc123", capture_unhandled=False)

    def test_capture_exception_com_traceback(self):
        try:
            {}["itens"]
        except KeyError:
            farohq.capture_exception(context={"path": "/checkout"})
        farohq.flush()
        self.assertEqual(len(RECEIVED), 1)
        r = RECEIVED[0]
        self.assertEqual(r["key"], "farohq_teste")
        self.assertEqual(r["body"]["exception"]["type"], "KeyError")
        self.assertIn("test_farohq.py", r["body"]["exception"]["stacktrace"])
        self.assertEqual(r["body"]["context"]["path"], "/checkout")
        self.assertEqual(r["body"]["release"], "abc123")

    def test_logging_error_vira_evento_info_nao(self):
        log = logging.getLogger("loja.pedidos")
        log.info("não vai")
        try:
            1 / 0
        except ZeroDivisionError:
            log.exception("Falha ao calcular total")
        farohq.flush()
        msgs = [r["body"]["message"] for r in RECEIVED]
        self.assertEqual(msgs, ["Falha ao calcular total"])
        self.assertEqual(RECEIVED[0]["body"]["exception"]["type"], "ZeroDivisionError")

    def test_rastro_da_requisicao_e_trace_id(self):
        logging.getLogger().setLevel(logging.INFO)
        log = logging.getLogger("loja.checkout")
        log.info("linha antiga fora do scope")
        with farohq.scope(trace_id="req-42"):
            log.debug("debug não entra")
            log.info("POST /checkout pedido %d", 42)
            log.warning("estoque baixo")
            log.error("Falha no checkout")
        farohq.flush()
        b = RECEIVED[0]["body"]
        self.assertEqual(b["traceId"], "req-42")
        self.assertEqual([c["message"] for c in b["breadcrumbs"]], ["POST /checkout pedido 42", "estoque baixo"])
        self.assertEqual(b["breadcrumbs"][1]["level"], "WARNING")

    def test_asgi_middleware_le_traceparent(self):
        import asyncio

        async def app(scope_, receive, send):
            farohq.add_breadcrumb("dentro da rota")
            farohq.capture_message("falhou")

        mw = farohq.FaroHQASGIMiddleware(app)
        tp = b"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        asyncio.run(mw({"type": "http", "headers": [(b"traceparent", tp)]}, None, None))
        farohq.flush()
        b = RECEIVED[0]["body"]
        self.assertEqual(b["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(b["breadcrumbs"][0]["message"], "dentro da rota")

    def test_ship_logs_envia_linhas_em_lote(self):
        farohq.init(key="k", endpoint=self.url, service="loja", capture_unhandled=False, ship_logs=True)
        logging.getLogger().setLevel(logging.DEBUG)
        log = logging.getLogger("loja.estoque")
        with farohq.scope(trace_id="req-5"):
            log.debug("debug fica de fora")
            log.info("Estoque atualizado: SKU %d", 123)
            farohq.log("warn", "Estoque baixo", {"sku": 123})
        farohq.flush(5)
        lines = [l for r in RECEIVED if r["path"].endswith("/ingest/logs") for l in r["body"]]
        self.assertEqual([l["message"] for l in lines], ["Estoque atualizado: SKU 123", "Estoque baixo"])
        self.assertEqual(lines[0]["traceId"], "req-5")
        self.assertEqual(lines[1]["level"], "WARN")
        self.assertEqual(lines[1]["attributes"], {"sku": 123})
        self.assertFalse([r for r in RECEIVED if r["path"].endswith("/ingest/event")])

    def test_sem_chave_nao_envia(self):
        farohq.init(key="", endpoint=self.url, capture_unhandled=False)
        farohq.capture_message("x")
        farohq.flush()
        self.assertEqual(RECEIVED, [])

    def test_endpoint_fora_do_ar_nao_lanca(self):
        farohq.init(key="k", endpoint="http://127.0.0.1:1/fora", capture_unhandled=False)
        farohq.capture_message("x")
        farohq.flush(2)


if __name__ == "__main__":
    unittest.main()
