import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

const _version = '0.1.0';
const _defaultEndpoint = 'https://api.farohq.com.br/api/v1';
const _maxQueue = 50;

/// Configuração do FaroHQ no app.
class FaroHQOptions {
  /// Chave PÚBLICA do projeto (farohq_pk_...). Vai dentro do app; não use a chave de ingestão.
  final String publicKey;

  /// Endereço da API (padrão: nuvem do FaroHQ).
  final String endpoint;

  /// production, staging...
  final String environment;

  /// Versão do app (ex.: 1.4.0+12). Aparece no erro e separa os problemas por versão.
  final String? release;

  /// Nome do serviço no FaroHQ (padrão: app-android / app-ios).
  final String? service;

  /// Linhas de rastro guardadas para ir junto com o erro.
  final int maxBreadcrumbs;

  /// Hosts da sua API: as chamadas para eles levam o header traceparent (liga o erro do app ao backend).
  final List<String> tracePropagationHosts;

  /// Último filtro antes de enviar: devolva null para descartar o evento.
  final FaroHQEvent? Function(FaroHQEvent event)? beforeSend;

  /// false desliga o envio (ex.: em debug).
  final bool enabled;

  /// Cliente HTTP usado no envio (para testes).
  final http.Client? transport;

  const FaroHQOptions({
    required this.publicKey,
    this.endpoint = _defaultEndpoint,
    this.environment = 'production',
    this.release,
    this.service,
    this.maxBreadcrumbs = 30,
    this.tracePropagationHosts = const [],
    this.beforeSend,
    this.enabled = true,
    this.transport,
  });
}

/// Um erro a caminho do FaroHQ (pode ser alterado no beforeSend).
class FaroHQEvent {
  String message;
  String level;
  String type;
  String stacktrace;
  Map<String, Object?> context;

  FaroHQEvent({required this.message, required this.level, required this.type, required this.stacktrace, required this.context});
}

class _Crumb {
  final DateTime timestamp;
  final String level;
  final String? logger;
  final String message;
  _Crumb(this.level, this.logger, this.message) : timestamp = DateTime.now().toUtc();

  Map<String, Object?> toJson() =>
      {'timestamp': timestamp.toIso8601String(), 'level': level, 'logger': logger, 'message': message};
}

/// Ponto de entrada: `FaroHQ.init(...)` e as capturas manuais.
class FaroHQ {
  FaroHQ._();

  static FaroHQOptions? _options;
  static http.Client? _http;
  static final List<_Crumb> _crumbs = [];
  static final Map<String, Object?> _context = {};
  static final List<Map<String, Object?>> _queue = [];
  static final Set<String> _warned = {};
  static bool _rejected = false;
  static bool _sending = false;
  static Timer? _retry;
  static String? _screen;
  static bool _handlersInstalled = false;

  /// Configura o FaroHQ e roda o app capturando todo erro não tratado.
  ///
  /// ```dart
  /// void main() => FaroHQ.init(
  ///       const FaroHQOptions(publicKey: 'farohq_pk_...', release: '1.4.0+12'),
  ///       appRunner: () => runApp(const MeuApp()),
  ///     );
  /// ```
  static Future<void> init(FaroHQOptions options, {required FutureOr<void> Function() appRunner}) async {
    _options = options;
    _http = options.transport ?? http.Client();
    _rejected = false;
    if (options.enabled && options.publicKey.isNotEmpty) {
      unawaited(_verifyKey());
    }
    runZonedGuarded(() async {
      WidgetsFlutterBinding.ensureInitialized();
      _installHandlers();
      await appRunner();
    }, (error, stack) => captureException(error, stack, context: const {'origin': 'zone'}));
  }

  static void _installHandlers() {
    if (_handlersInstalled) return;
    _handlersInstalled = true;
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      captureException(details.exception, details.stack,
          context: {'origin': 'flutter', if (details.library != null) 'library': details.library});
      previous?.call(details);
    };
    final previousPlatform = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) {
      captureException(error, stack, context: const {'origin': 'platform'});
      return previousPlatform?.call(error, stack) ?? false;
    };
  }

  /// Envia um erro tratado (ex.: dentro de um catch).
  static Future<void> captureException(Object error, StackTrace? stack, {Map<String, Object?>? context}) {
    return _send(
      message: error.toString(),
      level: 'error',
      type: error.runtimeType.toString(),
      stacktrace: (stack ?? StackTrace.current).toString(),
      context: context,
    );
  }

  /// Envia uma mensagem (sem exceção), ex.: uma situação que não deveria acontecer.
  static Future<void> captureMessage(String message, {String level = 'warning', Map<String, Object?>? context}) {
    return _send(message: message, level: level, type: 'Message', stacktrace: StackTrace.current.toString(), context: context);
  }

  /// Guarda uma linha no rastro (vai junto com o próximo erro).
  static void addBreadcrumb(String message, {String level = 'INFO', String? category}) {
    final max = _options?.maxBreadcrumbs ?? 30;
    if (max <= 0) return;
    _crumbs.add(_Crumb(level, category, message.length > 1000 ? message.substring(0, 1000) : message));
    if (_crumbs.length > max) _crumbs.removeRange(0, _crumbs.length - max);
  }

  /// Contexto extra que vai em todo erro (ex.: plano do cliente, feature flag). Evite dados pessoais.
  static void setContext(String key, Object? value) => _context[key] = value;

  /// Tela atual (o NavigatorObserver atualiza sozinho).
  static void setScreen(String? name) => _screen = name;

  /// Manda o que estiver na fila (ex.: antes de fechar o app).
  static Future<void> flush() => _drain();

  static Future<void> _send({
    required String message,
    required String level,
    required String type,
    required String stacktrace,
    Map<String, Object?>? context,
  }) async {
    final o = _options;
    if (o == null || !o.enabled || _rejected) return;
    var event = FaroHQEvent(
      message: message,
      level: level,
      type: type,
      stacktrace: stacktrace,
      context: {..._context, ...?context},
    );
    if (o.beforeSend != null) {
      final filtered = o.beforeSend!(event);
      if (filtered == null) return;
      event = filtered;
    }
    final body = <String, Object?>{
      'message': event.message.length > 20000 ? event.message.substring(0, 20000) : event.message,
      'level': event.level,
      'environment': o.environment,
      'release': o.release,
      'service': o.service ?? _defaultService(),
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'exception': {'type': event.type, 'message': event.message, 'stacktrace': event.stacktrace},
      'context': event.context,
      'breadcrumbs': _crumbs.map((c) => c.toJson()).toList(),
      'device': _device(),
      'screen': _screen,
    };
    _queue.add(body);
    if (_queue.length > _maxQueue) _queue.removeAt(0);
    await _drain();
  }

  /// Envia a fila em ordem; sem rede, guarda e tenta de novo em 30 s.
  static Future<void> _drain() async {
    final o = _options;
    if (o == null || _sending || _queue.isEmpty || _rejected) return;
    _sending = true;
    try {
      while (_queue.isNotEmpty && !_rejected) {
        final event = _queue.first;
        http.Response res;
        try {
          res = await _http!
              .post(Uri.parse('${_base(o)}/ingest/mobile/error'),
                  headers: {'Content-Type': 'application/json', 'X-FaroHQ-Key': o.publicKey, 'User-Agent': 'farohq-flutter/$_version'},
                  body: jsonEncode(event))
              .timeout(const Duration(seconds: 10));
        } catch (_) {
          _scheduleRetry();
          return;
        }
        if (res.statusCode >= 500 || res.statusCode == 429) {
          _checkResponse(res);
          _scheduleRetry();
          return;
        }
        _queue.removeAt(0);
        _checkResponse(res);
      }
    } finally {
      _sending = false;
    }
  }

  static void _scheduleRetry() {
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 30), () => unawaited(_drain()));
  }

  /// Confere a chave ao iniciar: sem isso, uma chave errada só apareceria (ou não) no primeiro erro.
  static Future<void> _verifyKey() async {
    final o = _options!;
    try {
      final res = await _http!
          .get(Uri.parse('${_base(o)}/ingest/mobile/ping'), headers: {'X-FaroHQ-Key': o.publicKey})
          .timeout(const Duration(seconds: 8));
      _checkResponse(res);
    } catch (_) {
      // Sem rede ao abrir o app: normal no celular, não avisa
    }
  }

  /// Recusa do FaroHQ não passa em silêncio: aparece uma vez no console de debug com o motivo.
  static void _checkResponse(http.Response res) {
    final s = res.statusCode;
    if (s < 400 || s >= 500) return;
    var reason = '';
    try {
      final m = jsonDecode(res.body);
      if (m is Map && m['message'] is String) reason = ': ${m['message']}';
    } catch (_) {}
    if (s == 401 || s == 403) {
      _rejected = true;
      _queue.clear();
      _warnOnce('$s', 'Envio recusado ($s)$reason. Nada deste app está sendo enviado ao FaroHQ.');
    } else if (s == 404) {
      _warnOnce('404', 'Endereço do FaroHQ não encontrado (404): confira o endpoint (${_options?.endpoint}).');
    } else if (s == 429) {
      _warnOnce('429', 'Limite atingido (429)$reason.');
    }
  }

  static void _warnOnce(String code, String message) {
    if (_warned.add(code)) debugPrint('[FaroHQ] $message');
  }

  static String _base(FaroHQOptions o) => o.endpoint.replaceAll(RegExp(r'/+$'), '');

  static String _defaultService() {
    if (kIsWeb) return 'app-web';
    try {
      return 'app-${Platform.operatingSystem}';
    } catch (_) {
      return 'app';
    }
  }

  static Map<String, Object?> _device() {
    final d = <String, Object?>{'dartVersion': _dartVersion()};
    try {
      d['platform'] = Platform.operatingSystem;
      d['osVersion'] = Platform.operatingSystemVersion;
      d['locale'] = Platform.localeName;
    } catch (_) {
      d['platform'] = kIsWeb ? 'web' : 'unknown';
    }
    final release = _options?.release;
    if (release != null) {
      final parts = release.split('+');
      d['appVersion'] = parts.first;
      if (parts.length > 1) d['appBuild'] = parts[1];
    }
    return d;
  }

  static String? _dartVersion() {
    try {
      return Platform.version.split(' ').first;
    } catch (_) {
      return null;
    }
  }

  /// Hosts que recebem o traceparent (usado pelo FaroHQHttpClient).
  static List<String> get tracePropagationHosts => _options?.tracePropagationHosts ?? const [];

  /// Só para testes: volta ao estado inicial.
  @visibleForTesting
  static void reset() {
    _options = null;
    _http = null;
    _crumbs.clear();
    _context.clear();
    _queue.clear();
    _warned.clear();
    _rejected = false;
    _sending = false;
    _retry?.cancel();
    _retry = null;
    _screen = null;
  }

  /// Só para testes: configura sem rodar o app nem instalar os handlers.
  @visibleForTesting
  static Future<void> setupForTest(FaroHQOptions options) async {
    _options = options;
    _http = options.transport ?? http.Client();
    _rejected = false;
    await _verifyKey();
  }

  /// Só para testes: quantos eventos esperam na fila.
  @visibleForTesting
  static int get queued => _queue.length;
}
