(function () {
  'use strict';

  var selector = document.getElementById('balanceCurrency');
  var total = document.getElementById('totalBalance');
  var note = document.getElementById('balanceConversionNote');
  if (!selector || !total) return;

  // NGN and USD are two converted views of the same combined wallet value.
  // The API also supplies actualNgn/actualUsd for audit and account detail views.
  var state = { ngn: null, usd: null, loaded: false };

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
    var amount = currency === 'USD' ? state.usd : state.ngn;

    if (amount === null || !Number.isFinite(amount) || amount < 0) {
      total.textContent = '—';
      if (note) note.textContent = 'The selected wallet balance is unavailable. Please refresh or contact support.';
      return;
    }

    total.textContent = (currency === 'USD' ? '$' : '₦') + format(amount, currency);
    if (note) {
      note.textContent = currency === 'USD'
        ? 'Showing the combined wallet value converted to USD. This is not an additional balance.'
        : 'Showing the combined wallet value converted to NGN. This is not an additional balance.';
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
      // Display the combined equivalent in the selected currency.
      // Never show zero as a valid balance if wallet setup is unavailable.
      state.ngn = data.configured === false || data.ngn === null || data.ngn === undefined || data.ngn === ''
        ? null : Number(data.ngn);
      state.usd = data.configured === false || data.usd === null || data.usd === undefined || data.usd === ''
        ? null : Number(data.usd);
      state.loaded = true;
      render();
    })
    .catch(function () {
      state.loaded = false;
      total.textContent = '—';
      if (note) note.textContent = 'Wallet balance is temporarily unavailable. Please refresh and try again.';
    });
})();