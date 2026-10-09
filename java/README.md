# farohq-java

Envia os erros de aplicações Java (Spring Boot, Quarkus, Micronaut, qualquer app com Logback)
para o [FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz com IA lendo o seu código.

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
| `GIT_SHA` | Commit do deploy: é com ele que a IA lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

Java 11+, sem dependências obrigatórias (Logback é opcional). Fila em memória e envio em
thread de fundo: nunca bloqueia a requisição nem derruba a aplicação.
