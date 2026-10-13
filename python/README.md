# farohq

Envia os erros de aplicações Python (Django, Flask, FastAPI, scripts e jobs) para o
[FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz lendo o seu código.

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
| `GIT_SHA` | Commit do deploy: é com ele que o FaroHQ lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

Sem dependências. O envio acontece numa thread de fundo e nunca derruba a aplicação.
Em scripts curtos, chame `farohq.flush()` antes de sair (o `atexit` já faz isso).

## Logs (opcional)

Além dos erros, o FaroHQ guarda os logs da aplicação: busca, filtros, ao vivo e a requisição
inteira (pelo traceId) ao lado do erro. Para ligar, defina `FAROHQ_LOGS=true`. As linhas vão em
lote, a cada 2 segundos, numa thread de fundo; com o FaroHQ fora do ar, elas são descartadas e a
aplicação segue normalmente. O pacote grátis inclui 1 GB por mês, guardado por 3 dias.

`farohq.init(ship_logs=True, logs_level=logging.INFO)` envia o que passa pelo `logging`;
para logs estruturados use `farohq.log("info", "Pedido pago", {"pedido": 42})`.
