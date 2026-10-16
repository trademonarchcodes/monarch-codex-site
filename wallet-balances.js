(function () {
  'use strict';
  var selector = document.getElementById('balanceCurrency');
  var total = document.getElementById('totalBalance');
  var note = document.getElementById('balanceConversionNote');
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
    var rate = Number(state.rate);
    var hasRate = Number.isFinite(rate) && rate > 0;
    if (selector.value === 'USD') {
      var usdEquivalent = hasRate ? state.usd + (state.ngn / rate) : state.usd;
      total.textContent = '
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
      state.rate = Number(data.rate) > 0 ? Number(data.rate) : null;
      render();
    })
    .catch(function () {
      if (note) note.textContent = 'Wallet balances are temporarily unavailable. Refresh the page to try again.';
    });
})(); + format(usdEquivalent, 'USD');
      if (note) note.textContent = hasRate
        ? 'Combined wallet value, converted at ₦' + format(rate, 'NGN') + ' per $1. Display only; wallet balances remain in their original currencies.'
        : 'Showing your USD wallet balance. Currency conversion is temporarily unavailable.';
    } else {
      var ngnEquivalent = hasRate ? state.ngn + (state.usd * rate) : state.ngn;
      total.textContent = '₦' + format(ngnEquivalent, 'NGN');
      if (note) note.textContent = hasRate
        ? 'Combined wallet value, converted at ₦' + format(rate, 'NGN') + ' per $1. Display only; wallet balances remain in their original currencies.'
        : 'Showing your NGN wallet balance. Currency conversion is temporarily unavailable.';
    }
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
      render();
    })
    .catch(function () {
      if (note) note.textContent = 'Wallet balances are temporarily unavailable. Refresh the page to try again.';
    });
})();