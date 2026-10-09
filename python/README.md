# farohq

Envia os erros de aplicações Python (Django, Flask, FastAPI, scripts e jobs) para o
[FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz com IA lendo o seu código.

```bash
pip install farohq
```

```python
import farohq

farohq.init(service="minha-api")  # chave em FAROHQ_KEY
```

Pronto: tudo que for logado com nível `ERROR` vira evento, inclusive as exceções não tratadas
do Django (`django.request`), Flask e FastAPI/uvicorn. Erros tratados também podem ser enviados:

```python
try:
    fechar_pedido(42)
except Exception:
    farohq.capture_exception(context={"pedido": 42})
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória) |
| `FAROHQ_ENV` | Ambiente (padrão `production`) |
| `GIT_SHA` | Commit do deploy: é com ele que a IA lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

Sem dependências. O envio acontece numa thread de fundo e nunca derruba a aplicação.
Em scripts curtos, chame `farohq.flush()` antes de sair (o `atexit` já faz isso).
