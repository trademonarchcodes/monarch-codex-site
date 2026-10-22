# Monarch Codex — Native Android App

This is the first Flutter app foundation for Monarch Codex. It is kept in its own `android-app/` directory and branch so the existing website is not changed.

## Current starter scope
- Native Flutter interface with Monarch Codex black-and-gold styling.
- Offline paper-trading simulator with virtual funds.
- Locally persisted practice balance and simulated trade log.
- Clear demo-price and simulated-trading labels.
- No real-money trading, deposits, withdrawals, or live market-data claims.

## Run locally
Install Flutter and Android Studio, then from this directory:

```sh
flutter pub get
flutter analyze
flutter test
flutter run
```

## Before a public release
1. Create a dedicated Android repository or move this subproject into one after the initial review.
2. Connect only to reviewed, authenticated backend API endpoints. Never embed server secrets in the app.
3. Replace sample/demo prices only with a licensed, reliable market-data source and show freshness timestamps.
4. Add secure authentication, privacy/data-safety review, network error handling, and device testing.
5. Complete legal and regulatory review for any financial services before enabling real-money features.
6. Configure Android application ID, app signing, store artwork, Play Console declarations, and release build.

Practice trades use virtual funds and do not represent real orders or market prices.
