import 'package:flutter_test/flutter_test.dart';
import 'package:monarch_codex/main.dart';

void main() {
  testWidgets('Monarch Codex opens with offline practice messaging',
      (tester) async {
    await tester.pumpWidget(const MonarchCodexApp());
    await tester.pumpAndSettle();

    expect(find.text('MONARCH CODEX'), findsOneWidget);
    expect(find.text('Build your edge.'), findsOneWidget);
    expect(find.textContaining('OFFLINE-READY MODE'), findsOneWidget);
  });
}
