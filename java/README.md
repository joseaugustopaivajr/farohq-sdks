# farohq-java

Envia os erros de aplicações Java (Spring Boot, Quarkus, Micronaut, qualquer app com Logback)
para o [FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz lendo o seu código.

**Gradle**

```groovy
implementation 'br.com.farohq:farohq-java:0.1.0'
```

**Maven**

```xml
<dependency>
  <groupId>br.com.farohq</groupId>
  <artifactId>farohq-java</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Spring Boot / Logback

`src/main/resources/logback-spring.xml`:

```xml
<configuration>
  <include resource="org/springframework/boot/logging/logback/base.xml"/>
  <appender name="FAROHQ" class="br.com.farohq.logback.FaroHQAppender">
    <service>minha-api</service>
  </appender>
  <root level="INFO">
    <appender-ref ref="FAROHQ"/>
  </root>
</configuration>
```

Tudo que for logado com nível `ERROR` (inclusive exceções não tratadas do Spring) vira evento.

## Sem Logback

```java
FaroHQ.init(new FaroHQOptions().service("minha-api"));
FaroHQ.installUncaughtExceptionHandler();

try { pedidos.fechar(42); } catch (Exception e) { FaroHQ.captureException(e, Map.of("pedido", "42")); }
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória) |
| `FAROHQ_ENV` | Ambiente (padrão `production`) |
| `GIT_SHA` | Commit do deploy: é com ele que o FaroHQ lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

Java 11+, sem dependências obrigatórias (Logback é opcional). Fila em memória e envio em
thread de fundo: nunca bloqueia a requisição nem derruba a aplicação.

## Logs (opcional)

Além dos erros, o FaroHQ guarda os logs da aplicação: busca, filtros, ao vivo e a requisição
inteira (pelo traceId) ao lado do erro. Para ligar, defina `FAROHQ_LOGS=true`. As linhas vão em
lote, a cada 2 segundos, numa thread de fundo; com o FaroHQ fora do ar, elas são descartadas e a
aplicação segue normalmente. O pacote grátis inclui 1 GB por mês, guardado por 3 dias.

No Logback: `<shipLogs>true</shipLogs>` e `<logsLevel>INFO</logsLevel>` dentro do appender.
