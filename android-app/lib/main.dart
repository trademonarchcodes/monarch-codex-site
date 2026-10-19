import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  runApp(const MonarchCodexApp());
}

const gold = Color(0xFFD9AE52);
const ink = Color(0xFF0B0C0F);
const panel = Color(0xFF15171C);
const muted = Color(0xFF969BA6);

class MonarchCodexApp extends StatelessWidget {
  const MonarchCodexApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Monarch Codex',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: ink,
        colorScheme: const ColorScheme.dark(
          primary: gold,
          secondary: gold,
          surface: panel,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: ink,
          foregroundColor: Colors.white,
          elevation: 0,
        ),
        cardTheme: CardThemeData(
          color: panel,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: const BorderSide(color: Color(0xFF292C33)),
          ),
        ),
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: panel,
          indicatorColor: Color(0xFF3A3020),
          labelTextStyle: WidgetStatePropertyAll(
            TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: gold,
            foregroundColor: ink,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
        ),
      ),
      home: const MonarchHome(),
    );
  }
}

class PracticeTrade {
  const PracticeTrade({
    required this.symbol,
    required this.side,
    required this.quantity,
    required this.price,
    required this.time,
  });

  final String symbol;
  final String side;
  final double quantity;
  final double price;
  final DateTime time;

  Map<String, dynamic> toJson() => {
        'symbol': symbol,
        'side': side,
        'quantity': quantity,
        'price': price,
        'time': time.toIso8601String(),
      };

  factory PracticeTrade.fromJson(Map<String, dynamic> json) => PracticeTrade(
        symbol: json['symbol'] as String,
        side: json['side'] as String,
        quantity: (json['quantity'] as num).toDouble(),
        price: (json['price'] as num).toDouble(),
        time: DateTime.tryParse(json['time'] as String? ?? '') ?? DateTime.now(),
      );
}

class MonarchHome extends StatefulWidget {
  const MonarchHome({super.key});

  @override
  State<MonarchHome> createState() => _MonarchHomeState();
}

class _MonarchHomeState extends State<MonarchHome> {
  int _tab = 0;
  double _cash = 10000;
  final Map<String, double> _holdings = {};
  final List<PracticeTrade> _trades = [];
  bool _loaded = false;

  // Fixed illustrative prices, not live quotes. They make practice usable offline.
  final Map<String, double> _demoPrices = {
    'BTC/USD': 67450,
    'ETH/USD': 3520,
    'EUR/USD': 1.0842,
    'XAU/USD': 2338.50,
  };

  @override
  void initState() {
    super.initState();
    _loadPractice();
  }

  Future<void> _loadPractice() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('practice_trades_v1');
    final restored = <PracticeTrade>[];
    if (raw != null) {
      try {
        final decoded = jsonDecode(raw) as List<dynamic>;
        restored.addAll(decoded.map((item) =>
            PracticeTrade.fromJson(Map<String, dynamic>.from(item as Map))));
      } catch (_) {
        // Ignore invalid local practice history; never affect real account data.
      }
    }
    if (!mounted) return;
    setState(() {
      _cash = prefs.getDouble('practice_cash_v1') ?? 10000;
      _trades
        ..clear()
        ..addAll(restored);
      _rebuildHoldings();
      _loaded = true;
    });
  }

  Future<void> _savePractice() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble('practice_cash_v1', _cash);
    await prefs.setString(
      'practice_trades_v1',
      jsonEncode(_trades.map((trade) => trade.toJson()).toList()),
    );
  }

  void _rebuildHoldings() {
    _holdings.clear();
    for (final trade in _trades.reversed) {
      final signed = trade.side == 'BUY' ? trade.quantity : -trade.quantity;
      _holdings.update(trade.symbol, (value) => value + signed,
          ifAbsent: () => signed);
    }
    _holdings.removeWhere((_, quantity) => quantity.abs() < 0.0000001);
  }

  Future<void> _placePracticeTrade(String symbol, String side) async {
    final price = _demoPrices[symbol]!;
    const quantity = 0.01;
    final cost = price * quantity;
    if (side == 'BUY' && _cash < cost) {
      _notice('Not enough virtual funds for this practice trade.');
      return;
    }
    if (side == 'SELL' && (_holdings[symbol] ?? 0) < quantity) {
      _notice('You need a practice position before selling.');
      return;
    }
    setState(() {
      _cash += side == 'BUY' ? -cost : cost;
      _trades.insert(
        0,
        PracticeTrade(
          symbol: symbol,
          side: side,
          quantity: quantity,
          price: price,
          time: DateTime.now(),
        ),
      );
      _rebuildHoldings();
    });
    await _savePractice();
    if (mounted) _notice('$side 0.01 $symbol recorded in practice mode.');
  }

  Future<void> _resetPractice() async {
    setState(() {
      _cash = 10000;
      _holdings.clear();
      _trades.clear();
    });
    await _savePractice();
    if (mounted) _notice('Practice account reset to 10,000 virtual USD.');
  }

  void _notice(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      _dashboard(),
      _practice(),
      _history(),
      _learn(),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border.all(color: gold, width: 1.4),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Text('M', style: TextStyle(color: gold, fontWeight: FontWeight.w900)),
            ),
            const SizedBox(width: 10),
            const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('MONARCH CODEX', style: TextStyle(fontSize: 14, letterSpacing: 1.3, fontWeight: FontWeight.w800)),
                Text('DISCIPLINE. STRATEGY. GROWTH.', style: TextStyle(fontSize: 8, letterSpacing: 1.1, color: muted)),
              ],
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Reset practice account',
            onPressed: _resetPractice,
            icon: const Icon(Icons.restart_alt, color: muted),
          ),
        ],
      ),
      body: SafeArea(
        child: !_loaded
            ? const Center(child: CircularProgressIndicator(color: gold))
            : AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                child: pages[_tab],
              ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.grid_view_rounded), label: 'Overview'),
          NavigationDestination(icon: Icon(Icons.candlestick_chart), label: 'Practice'),
          NavigationDestination(icon: Icon(Icons.receipt_long), label: 'History'),
          NavigationDestination(icon: Icon(Icons.school_outlined), label: 'Learn'),
        ],
      ),
    );
  }

  Widget _dashboard() => ListView(
        padding: const EdgeInsets.all(18),
        children: [
          _offlineBanner(),
          const SizedBox(height: 18),
          const Text('YOUR COMMAND CENTER', style: TextStyle(color: gold, fontSize: 11, letterSpacing: 1.8, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Build your edge.', style: TextStyle(fontSize: 29, fontWeight: FontWeight.w800)),
          const SizedBox(height: 5),
          const Text('Practice, learn, and stay consistent — even offline.', style: TextStyle(color: muted)),
          const SizedBox(height: 20),
          _balanceCard(),
          const SizedBox(height: 18),
          _sectionTitle('Market watch', 'ILLUSTRATIVE SNAPSHOT'),
          const SizedBox(height: 10),
          ..._demoPrices.entries.map((entry) => _marketRow(entry.key, entry.value)),
          const SizedBox(height: 18),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => setState(() => _tab = 1),
              icon: const Icon(Icons.candlestick_chart),
              label: const Text('Open practice trading'),
            ),
          ),
          const SizedBox(height: 12),
          const Text('Prices are fixed demo values for offline practice, not live market quotes or investment advice.', style: TextStyle(color: muted, fontSize: 11)),
        ],
      );

  Widget _practice() => ListView(
        padding: const EdgeInsets.all(18),
        children: [
          _offlineBanner(),
          const SizedBox(height: 18),
          const Text('PAPER TRADING', style: TextStyle(color: gold, fontSize: 11, letterSpacing: 1.8, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Train without risk.', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Every order here uses virtual money only. No broker connection and no real orders.', style: TextStyle(color: muted)),
          const SizedBox(height: 16),
          _balanceCard(),
          const SizedBox(height: 16),
          ..._demoPrices.entries.map((entry) => Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(child: Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
                          Text(_formatPrice(entry.value), style: const TextStyle(fontWeight: FontWeight.w700)),
                        ],
                      ),
                      const SizedBox(height: 4),
                      const Align(alignment: Alignment.centerLeft, child: Text('Fixed demo price • 0.01 unit per order', style: TextStyle(color: muted, fontSize: 11))),
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          Expanded(child: FilledButton(onPressed: () => _placePracticeTrade(entry.key, 'BUY'), child: const Text('Buy practice'))),
                          const SizedBox(width: 10),
                          Expanded(child: OutlinedButton(onPressed: () => _placePracticeTrade(entry.key, 'SELL'), child: const Text('Sell practice'))),
                        ],
                      ),
                    ],
                  ),
                ),
              )),
          const SizedBox(height: 8),
          const Text('Practice results are educational only. Fixed prices do not simulate real market movement.', style: TextStyle(color: muted, fontSize: 11)),
        ],
      );

  Widget _history() => ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const Text('PRACTICE JOURNAL', style: TextStyle(color: gold, fontSize: 11, letterSpacing: 1.8, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Your trade history', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          const Text('Saved on this device and available offline.', style: TextStyle(color: muted)),
          const SizedBox(height: 16),
          if (_trades.isEmpty)
            const Card(child: Padding(padding: EdgeInsets.all(22), child: Text('No practice trades yet. Open Practice to place your first simulated order.', style: TextStyle(color: muted))))
          else
            ..._trades.map((trade) => Card(
                  child: ListTile(
                    leading: CircleAvatar(
                      backgroundColor: trade.side == 'BUY' ? const Color(0xFF18382B) : const Color(0xFF3A2527),
                      child: Icon(trade.side == 'BUY' ? Icons.south_west : Icons.north_east, color: trade.side == 'BUY' ? const Color(0xFF5BD49A) : const Color(0xFFFF8D8D), size: 18),
                    ),
                    title: Text('${trade.side} · ${trade.symbol}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text('${trade.quantity.toStringAsFixed(2)} units · ${trade.time.toLocal().toString().substring(0, 16)}'),
                    trailing: Text(_formatPrice(trade.price), style: const TextStyle(fontWeight: FontWeight.w700)),
                  ),
                )),
        ],
      );

  Widget _learn() => ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const Text('THE ACADEMY', style: TextStyle(color: gold, fontSize: 11, letterSpacing: 1.8, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Master the process.', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800)),
          const SizedBox(height: 7),
          const Text('Starter lessons are available offline. More lessons can be added as reviewed learning content.', style: TextStyle(color: muted)),
          const SizedBox(height: 16),
          _lesson(Icons.shield_outlined, 'Protect your capital', 'Define risk before entering a trade. Never risk money you cannot afford to lose.'),
          _lesson(Icons.checklist_rounded, 'Build a trading plan', 'Write down your setup, entry conditions, invalidation point, and exit rules.'),
          _lesson(Icons.psychology_alt_outlined, 'Control your psychology', 'Avoid revenge trading. Record decisions and review them without judgment.'),
          _lesson(Icons.menu_book_outlined, 'Keep a journal', 'Track your reasoning, not just whether a simulated trade wins or loses.'),
          const SizedBox(height: 12),
          const Text('Educational content only. Not financial advice.', style: TextStyle(color: muted, fontSize: 11)),
        ],
      );

  Widget _offlineBanner() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFF20251F),
          border: Border.all(color: const Color(0xFF394532)),
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Row(
          children: [
            Icon(Icons.cloud_off_outlined, color: Color(0xFFB9D39A), size: 18),
            SizedBox(width: 8),
            Expanded(child: Text('OFFLINE-READY MODE · DEMO DATA', style: TextStyle(color: Color(0xFFB9D39A), fontSize: 10, letterSpacing: 1, fontWeight: FontWeight.w800))),
          ],
        ),
      );

  Widget _balanceCard() {
    final exposure = _holdings.entries.fold<double>(
      0,
      (sum, entry) => sum + entry.value * (_demoPrices[entry.key] ?? 0),
    );
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF302719), Color(0xFF171719)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF6B542D)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.account_balance_wallet_outlined, color: gold, size: 18),
              SizedBox(width: 8),
              Text('VIRTUAL PRACTICE BALANCE', style: TextStyle(color: Color(0xFFD7C7A5), fontSize: 10, letterSpacing: 1.2, fontWeight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 12),
          Text('${_formatPrice(_cash)} USD', style: const TextStyle(fontSize: 29, fontWeight: FontWeight.w900, letterSpacing: -0.5)),
          const SizedBox(height: 5),
          Text('Open position value: ${_formatPrice(exposure)}', style: const TextStyle(color: muted, fontSize: 12)),
          const SizedBox(height: 12),
          const Text('SIMULATED FUNDS ONLY — NO CASH VALUE', style: TextStyle(color: gold, fontSize: 9, letterSpacing: 1, fontWeight: FontWeight.w900)),
        ],
      ),
    );
  }

  Widget _marketRow(String symbol, double price) => Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ListTile(
          dense: true,
          leading: Container(
            width: 38,
            height: 38,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: const Color(0xFF29251D), borderRadius: BorderRadius.circular(11)),
            child: const Icon(Icons.show_chart_rounded, color: gold, size: 20),
          ),
          title: Text(symbol, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: const Text('Offline demo snapshot', style: TextStyle(color: muted, fontSize: 11)),
          trailing: Text(_formatPrice(price), style: const TextStyle(fontWeight: FontWeight.w800)),
        ),
      );

  Widget _sectionTitle(String title, String eyebrow) => Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(child: Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
          Text(eyebrow, style: const TextStyle(color: muted, fontSize: 8, letterSpacing: 1)),
        ],
      );

  Widget _lesson(IconData icon, String title, String description) => Card(
        margin: const EdgeInsets.only(bottom: 10),
        child: Padding(
          padding: const EdgeInsets.all(15),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(color: const Color(0xFF302719), borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: gold),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 5),
                    Text(description, style: const TextStyle(color: muted, height: 1.45, fontSize: 12)),
                  ],
                ),
              ),
            ],
          ),
        ),
      );

  String _formatPrice(double value) => value.toStringAsFixed(2).replaceAllMapped(
        RegExp(r'\B(?=(\d{3})+(?!\d))'),
        (match) => ',',
      );
}
