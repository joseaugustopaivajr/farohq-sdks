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
        RECEIVED.append({"key": self.headers.get("X-FaroHQ-Key"), "body": json.loads(body)})
        self.send_response(202)
        self.end_headers()

    def log_message(self, *args):
        pass


class FaroHQTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = "http://127.0.0.1:%d/ingest" % cls.server.server_address[1]

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
