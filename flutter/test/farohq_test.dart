import 'dart:convert';

import 'package:farohq_flutter/farohq_flutter.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  late List<http.Request> sent;

  MockClient server({int ping = 200, int error = 202, bool offline = false}) => MockClient((req) async {
        sent.add(req);
        if (offline) throw http.ClientException('sem rede');
        if (req.url.path.endsWith('/ping')) {
          return http.Response(jsonEncode(ping == 200 ? {'ok': true} : {'status': ping, 'message': 'Chave pública não encontrada'}), ping);
        }
        return http.Response('{"groupId":1}', error);
      });

  setUp(() {
    sent = [];
    FaroHQ.reset();
  });

  test('envia o erro com chave, tipo, pilha, rastro, aparelho e tela', () async {
    await FaroHQ.setupForTest(FaroHQOptions(publicKey: 'farohq_pk_teste', release: '1.4.0+12', transport: server()));
    FaroHQ.addBreadcrumb('Clicou em Finalizar compra');
    FaroHQ.setScreen('/checkout');
    FaroHQ.setContext('plano', 'pro');
    await FaroHQ.captureException(StateError('pedido sem itens'), StackTrace.current, context: {'pedido': 42});

    final post = sent.firstWhere((r) => r.url.path.endsWith('/ingest/mobile/error'));
    expect(post.headers['X-FaroHQ-Key'], 'farohq_pk_teste');
    final body = jsonDecode(post.body) as Map<String, dynamic>;
    expect(body['exception']['type'], 'StateError');
    expect(body['exception']['stacktrace'], contains('farohq_test.dart'));
    expect(body['breadcrumbs'].first['message'], 'Clicou em Finalizar compra');
    expect(body['screen'], '/checkout');
    expect(body['context'], {'plano': 'pro', 'pedido': 42});
    expect(body['device']['appVersion'], '1.4.0');
    expect(body['device']['appBuild'], '12');
    expect(body['release'], '1.4.0+12');
  });

  test('chave recusada: avisa uma vez e para de enviar', () async {
    final logs = <String>[];
    final original = debugPrint;
    debugPrint = (String? m, {int? wrapWidth}) => logs.add(m ?? '');
    try {
      await FaroHQ.setupForTest(FaroHQOptions(publicKey: 'farohq_pk_errada', transport: server(ping: 401)));
      await FaroHQ.captureException(Exception('depois da recusa'), null);
      await FaroHQ.captureException(Exception('de novo'), null);
    } finally {
      debugPrint = original;
    }
    expect(sent.where((r) => r.url.path.endsWith('/error')), isEmpty);
    expect(logs.where((l) => l.startsWith('[FaroHQ]')).length, 1);
    expect(logs.first, contains('Envio recusado (401): Chave pública não encontrada'));
  });

  test('sem rede o erro fica na fila (não se perde)', () async {
    await FaroHQ.setupForTest(FaroHQOptions(publicKey: 'farohq_pk_teste', transport: server(offline: true)));
    await FaroHQ.captureException(Exception('offline'), null);
    expect(FaroHQ.queued, 1);
  });

  test('beforeSend pode descartar ou alterar', () async {
    await FaroHQ.setupForTest(FaroHQOptions(
      publicKey: 'farohq_pk_teste',
      transport: server(),
      beforeSend: (e) => e.message.contains('ignorar') ? null : (e..context['filtrado'] = true),
    ));
    await FaroHQ.captureMessage('ignorar este');
    await FaroHQ.captureMessage('enviar este');
    final posts = sent.where((r) => r.url.path.endsWith('/error')).toList();
    expect(posts.length, 1);
    expect(jsonDecode(posts.first.body)['context']['filtrado'], true);
  });

  testWidgets('navegação vira rastro e tela atual', (tester) async {
    await FaroHQ.setupForTest(FaroHQOptions(publicKey: 'farohq_pk_teste', transport: server()));
    final key = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: key,
      color: const Color(0xFF000000),
      navigatorObservers: [FaroHQNavigatorObserver()],
      initialRoute: '/',
      onGenerateRoute: (s) => PageRouteBuilder(settings: s, pageBuilder: (_, __, ___) => const SizedBox()),
    ));
    key.currentState!.pushNamed('/checkout');
    await tester.pumpAndSettle();
    await FaroHQ.captureMessage('na tela de checkout');
    final body = jsonDecode(sent.lastWhere((r) => r.url.path.endsWith('/error')).body);
    expect(body['screen'], '/checkout');
    expect((body['breadcrumbs'] as List).map((c) => c['message']), contains('Tela: abriu /checkout (de /)'));
  });

  test('cliente HTTP registra a chamada e manda traceparent só para a sua API', () async {
    await FaroHQ.setupForTest(FaroHQOptions(publicKey: 'farohq_pk_teste', transport: server(), tracePropagationHosts: ['api.loja.com']));
    final seen = <http.BaseRequest>[];
    final client = FaroHQHttpClient(MockClient((req) async {
      seen.add(req);
      return http.Response('erro', req.url.host == 'api.loja.com' ? 500 : 200);
    }));
    await client.post(Uri.parse('https://api.loja.com/pedidos'));
    await client.get(Uri.parse('https://cdn.outro.com/x.json'));
    expect(seen[0].headers['traceparent'], matches(RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-01$')));
    expect(seen[1].headers.containsKey('traceparent'), isFalse);
    await FaroHQ.captureMessage('depois das chamadas');
    final crumbs = (jsonDecode(sent.lastWhere((r) => r.url.path.endsWith('/error')).body)['breadcrumbs'] as List)
        .map((c) => c['message'] as String)
        .toList();
    expect(crumbs.any((m) => m.startsWith('POST api.loja.com/pedidos → 500')), isTrue);
  });
}
