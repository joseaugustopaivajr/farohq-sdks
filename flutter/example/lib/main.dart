import 'package:farohq_flutter/farohq_flutter.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

final api = FaroHQHttpClient(http.Client());

void main() => FaroHQ.init(
      const FaroHQOptions(publicKey: 'farohq_pk_...', release: '1.0.0+1', environment: 'development'),
      appRunner: () => runApp(const ExemploApp()),
    );

class ExemploApp extends StatelessWidget {
  const ExemploApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'FaroHQ exemplo',
        navigatorObservers: [FaroHQNavigatorObserver()],
        initialRoute: '/',
        routes: {
          '/': (_) => const InicioPage(),
          '/checkout': (_) => const CheckoutPage(),
        },
      );
}

class InicioPage extends StatelessWidget {
  const InicioPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Início')),
        body: Center(
          child: FilledButton(onPressed: () => Navigator.pushNamed(context, '/checkout'), child: const Text('Ir para o checkout')),
        ),
      );
}

class CheckoutPage extends StatelessWidget {
  const CheckoutPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Checkout')),
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            FilledButton(
              onPressed: () => throw StateError('pedido sem itens'), // erro não tratado: vai sozinho
              child: const Text('Gerar erro não tratado'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () async {
                try {
                  await api.get(Uri.parse('https://httpbin.org/status/500'));
                  throw Exception('pagamento recusado');
                } catch (e, st) {
                  FaroHQ.captureException(e, st, context: {'pedido': 42});
                }
              },
              child: const Text('Erro tratado com rastro HTTP'),
            ),
          ]),
        ),
      );
}
