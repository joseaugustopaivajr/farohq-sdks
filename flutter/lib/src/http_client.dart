import 'dart:math';

import 'package:http/http.dart' as http;

import 'farohq.dart';

/// Cliente `http` que registra cada chamada no rastro ("POST /api/pedidos → 500 (842ms)") e, para os
/// hosts em `tracePropagationHosts`, manda o header traceparent (liga o erro do app ao do backend).
///
/// ```dart
/// final client = FaroHQHttpClient(http.Client());
/// ```
class FaroHQHttpClient extends http.BaseClient {
  final http.Client _inner;
  final Random _random = Random.secure();

  FaroHQHttpClient(this._inner);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final started = DateTime.now();
    if (FaroHQ.tracePropagationHosts.contains(request.url.host) && !request.headers.containsKey('traceparent')) {
      request.headers['traceparent'] = '00-${_hex(16)}-${_hex(8)}-01';
    }
    final path = '${request.method} ${request.url.host}${request.url.path}';
    try {
      final res = await _inner.send(request);
      final ms = DateTime.now().difference(started).inMilliseconds;
      FaroHQ.addBreadcrumb('$path → ${res.statusCode} (${ms}ms)',
          level: res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO', category: 'http');
      return res;
    } catch (e) {
      final ms = DateTime.now().difference(started).inMilliseconds;
      FaroHQ.addBreadcrumb('$path → falhou (rede) (${ms}ms): $e', level: 'ERROR', category: 'http');
      rethrow;
    }
  }

  String _hex(int bytes) => List.generate(bytes, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

  @override
  void close() => _inner.close();
}
