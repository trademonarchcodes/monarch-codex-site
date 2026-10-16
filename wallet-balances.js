(function () {
  'use strict';
  var selector = document.getElementById('balanceCurrency');
  var total = document.getElementById('totalBalance');
  var note = document.getElementById('balanceConversionNote');
  var ngnNode = document.getElementById('walletNgn');
  var usdNode = document.getElementById('walletUsd');
  if (!selector || !total) return;

  var state = { ngn: 0, usd: 0, rate: null };
  function format(amount, currency) {
    return new Intl.NumberFormat(currency === 'NGN' ? 'en-NG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(amount) || 0);
  }
  var currencyButtons = Array.prototype.slice.call(document.querySelectorAll('[data-currency-toggle]'));
  function syncCurrencyToggle() {
    currencyButtons.forEach(function (button) {
      var active = button.getAttribute('data-currency-toggle') === selector.value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  function render() {
    if (selector.value === 'USD') {
      var totalUsd = state.rate === null ? state.usd : state.usd + state.ngn / state.rate;
      total.textContent = '$' + format(totalUsd, 'USD');
    } else {
      var totalNgn = state.rate === null ? state.ngn : state.ngn + state.usd * state.rate;
      total.textContent = '₦' + format(totalNgn, 'NGN');
    }
    if (note) note.textContent = state.rate === null
      ? 'The exchange rate is not configured, so the combined total cannot be converted yet.'
      : 'Combined wallet total uses the current platform conversion rate.';
  }
  selector.addEventListener('change', function () { syncCurrencyToggle(); render(); });
  currencyButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      selector.value = button.getAttribute('data-currency-toggle');
      syncCurrencyToggle();
      render();
    });
  });
  syncCurrencyToggle();
  fetch('/api/wallet-balances', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('Wallet balance request failed');
      return response.json();
    })
    .then(function (data) {
      state.ngn = Number(data.ngn) || 0;
      state.usd = Number(data.usd) || 0;
      state.rate = data.rate === null || data.rate === undefined || !Number.isFinite(Number(data.rate))
        ? null : Number(data.rate);
      if (ngnNode) ngnNode.textContent = '₦' + format(state.ngn, 'NGN');
      if (usdNode) usdNode.textContent = '$' + format(state.usd, 'USD');
      render();
    })
    .catch(function () {
      if (note) note.textContent = 'Wallet balances are temporarily unavailable. Refresh the page to try again.';
    });
})();