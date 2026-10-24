(function () {
  'use strict';

  var selector = document.getElementById('balanceCurrency');
  var total = document.getElementById('totalBalance');
  var note = document.getElementById('balanceConversionNote');
  if (!selector || !total) return;

  // Display only the real balance of the selected currency wallet.
  // Do not add the other currency's converted value to this amount.
  var state = { actualNgn: null, actualUsd: null, loaded: false };

  function format(amount, currency) {
    return new Intl.NumberFormat(currency === 'NGN' ? 'en-NG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  var currencyButtons = Array.prototype.slice.call(
    document.querySelectorAll('[data-currency-toggle]')
  );

  function syncCurrencyToggle() {
    currencyButtons.forEach(function (button) {
      var active = button.getAttribute('data-currency-toggle') === selector.value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function render() {
    if (!state.loaded) {
      total.textContent = '—';
      if (note) note.textContent = 'Loading your wallet balance…';
      return;
    }

    var currency = selector.value === 'USD' ? 'USD' : 'NGN';
    var amount = currency === 'USD' ? state.actualUsd : state.actualNgn;

    if (amount === null || !Number.isFinite(amount) || amount < 0) {
      total.textContent = '—';
      if (note) note.textContent = 'The selected wallet balance is unavailable. Please refresh or contact support.';
      return;
    }

    total.textContent = (currency === 'USD' ? '$' : '₦') + format(amount, currency);
    if (note) {
      note.textContent = currency === 'USD'
        ? 'Showing your actual USD wallet balance. Your NGN wallet is separate.'
        : 'Showing your actual NGN wallet balance. Your USD wallet is separate.';
    }
  }

  selector.addEventListener('change', function () {
    syncCurrencyToggle();
    render();
  });

  currencyButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      selector.value = button.getAttribute('data-currency-toggle');
      syncCurrencyToggle();
      render();
    });
  });

  syncCurrencyToggle();
  render();

  fetch('/api/wallet-balances', {
    credentials: 'same-origin',
    cache: 'no-store'
  })
    .then(function (response) {
      if (!response.ok) throw new Error('Wallet balance request failed');
      return response.json();
    })
    .then(function (data) {
      // The API supplies actualNgn/actualUsd alongside any combined equivalents.
      // Refuse to substitute combined values if actual balances are missing.
      state.actualNgn = data.actualNgn === null || data.actualNgn === undefined || data.actualNgn === ''
        ? null : Number(data.actualNgn);
      state.actualUsd = data.actualUsd === null || data.actualUsd === undefined || data.actualUsd === ''
        ? null : Number(data.actualUsd);
      state.loaded = true;
      render();
    })
    .catch(function () {
      state.loaded = false;
      total.textContent = '—';
      if (note) note.textContent = 'Wallet balance is temporarily unavailable. Please refresh and try again.';
    });
})();