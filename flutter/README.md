# FaroHQ para Flutter

Erros do seu app Flutter (Android e iOS) enviados ao [FaroHQ](https://www.farohq.com.br), com o rastro do que o usuário fez antes:
telas abertas, chamadas HTTP e o que você registrar. O FaroHQ agrupa o que é o mesmo problema, lê o seu código e aponta a causa.



## Instalação

```yaml
dependencies:
  farohq_flutter: ^0.1.0
```

## Uso

Use a **chave pública** do projeto (`farohq_pk_...`, em Configurações do projeto). Ela vai dentro do app e só permite
enviar erros para o seu projeto. **Nunca** coloque a chave de ingestão (a secreta) no app.

```dart
import 'package:farohq_flutter/farohq_flutter.dart';

void main() => FaroHQ.init(
      const FaroHQOptions(
        publicKey: 'farohq_pk_...',
        release: '1.4.0+12',          // versão do app (pubspec)
        environment: 'production',
        tracePropagationHosts: ['api.suaempresa.com.br'], // liga o erro do app ao do backend
      ),
      appRunner: () => runApp(const MeuApp()),
    );
```

Isso já captura os erros do Flutter (build, layout, gestos), os assíncronos e os da plataforma.

### Telas no rastro

```dart
MaterialApp(
  navigatorObservers: [FaroHQNavigatorObserver()],
  // use rotas com nome (settings.name) para aparecerem no rastro
);
```

### Chamadas HTTP no rastro

```dart
final client = FaroHQHttpClient(http.Client());
await client.get(Uri.parse('https://api.suaempresa.com.br/pedidos'));
```

### Erros tratados e contexto

```dart
try {
  await fecharPedido(42);
} catch (e, st) {
  FaroHQ.captureException(e, st, context: {'pedido': 42});
}

FaroHQ.addBreadcrumb('Aplicou cupom PRIMEIRA');
FaroHQ.setContext('plano', 'pro'); // evite dados pessoais
```

### Filtro antes de enviar

```dart
FaroHQOptions(
  publicKey: 'farohq_pk_...',
  beforeSend: (e) => e.message.contains('SocketException') ? null : e,
)
```

## Como funciona

- Sem rede, o erro fica numa fila (até 50) e é reenviado em 30 s.
- Ao iniciar, o SDK confere a chave. Se ela for recusada, aparece **uma vez** no console de debug, por exemplo
  `[FaroHQ] Envio recusado (401): Chave pública não encontrada...`, e o SDK para de enviar.
- Contexto enviado: plataforma, versão do sistema, versão e build do app (do `release`), idioma e versão do Dart.
  Nada de dados pessoais por padrão.
