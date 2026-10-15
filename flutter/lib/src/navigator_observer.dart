import 'package:flutter/widgets.dart';

import 'farohq.dart';

/// Coloque em `MaterialApp(navigatorObservers: [FaroHQNavigatorObserver()])`: cada troca de tela vira
/// uma linha no rastro e a tela atual vai junto com o erro.
class FaroHQNavigatorObserver extends NavigatorObserver {
  String? _name(Route<dynamic>? r) => r?.settings.name;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _changed(previousRoute, route, 'abriu');
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _changed(route, previousRoute, 'voltou para');
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    _changed(oldRoute, newRoute, 'trocou para');
  }

  void _changed(Route<dynamic>? from, Route<dynamic>? to, String verb) {
    final name = _name(to);
    if (name == null) return; // rotas sem nome (diálogos, bottom sheets) não poluem o rastro
    FaroHQ.setScreen(name);
    final origin = _name(from);
    FaroHQ.addBreadcrumb(origin == null ? 'Tela: $verb $name' : 'Tela: $verb $name (de $origin)', category: 'navigation');
  }
}
