# farohq-java

Envia os erros de aplicações Java (Spring Boot, Quarkus, Micronaut, qualquer app com Logback)
para o [FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz lendo o seu código.

Funciona em **Java e Kotlin** (Java 11+).

**Gradle (Kotlin DSL)**

```kotlin
implementation("br.com.farohq:farohq-java:0.2.0")
```

**Gradle (Groovy)**

```groovy
implementation 'br.com.farohq:farohq-java:0.2.0'
```

**Maven**

```xml
<dependency>
  <groupId>br.com.farohq</groupId>
  <artifactId>farohq-java</artifactId>
  <version>0.2.0</version>
</dependency>
```

## Spring Boot

**1. `src/main/resources/application.properties`** (a chave vem de variável de ambiente; não grave
a chave no repositório):

```properties
farohq.key=${FAROHQ_KEY:}
farohq.service=minha-api
farohq.environment=${FAROHQ_ENV:production}
farohq.release=${GIT_SHA:}
```

Ou no `application.yml`:

```yaml
farohq:
  key: ${FAROHQ_KEY:}
  service: minha-api
  environment: ${FAROHQ_ENV:production}
  release: ${GIT_SHA:}
```

**2. `src/main/resources/logback-spring.xml`** (lê as configurações acima):

```xml
<configuration>
  <include resource="org/springframework/boot/logging/logback/base.xml"/>

  <springProperty scope="context" name="farohqKey" source="farohq.key" defaultValue=""/>
  <springProperty scope="context" name="farohqService" source="farohq.service" defaultValue=""/>
  <springProperty scope="context" name="farohqEnv" source="farohq.environment" defaultValue="production"/>
  <springProperty scope="context" name="farohqRelease" source="farohq.release" defaultValue=""/>
  <springProperty scope="context" name="farohqEndpoint" source="farohq.endpoint" defaultValue=""/>

  <appender name="FAROHQ" class="br.com.farohq.logback.FaroHQAppender">
    <key>${farohqKey}</key>
    <service>${farohqService}</service>
    <environment>${farohqEnv}</environment>
    <release>${farohqRelease}</release>
    <endpoint>${farohqEndpoint}</endpoint>
  </appender>

  <root level="INFO">
    <appender-ref ref="FAROHQ"/>
  </root>
</configuration>
```

**3.** No deploy, defina `FAROHQ_KEY` (a chave do projeto no FaroHQ) e `GIT_SHA` (o commit, para a
análise ler o código certo).

Tudo que for logado com nível `ERROR` (inclusive exceções não tratadas do Spring) vira evento, com
as linhas de log anteriores da mesma requisição. Campos em branco no `application.properties` caem
nas variáveis de ambiente (`FAROHQ_KEY`, `FAROHQ_ENV`, `GIT_SHA`, `FAROHQ_ENDPOINT`).

### Sem Spring (Logback puro)

```xml
<appender name="FAROHQ" class="br.com.farohq.logback.FaroHQAppender">
  <service>minha-api</service>
</appender>
```

Chave e versão vêm de `FAROHQ_KEY` e `GIT_SHA`.

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
