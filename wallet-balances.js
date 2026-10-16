(function () {
  'use strict';
  var selector = document.getElementById('balanceCurrency');
  var total = document.getElementById('totalBalance');
  var note = document.getElementById('balanceConversionNote');
  if (!selector || !total) return;

  var state = { ngn: 0, usd: 0 };
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
      render();
    })
    .catch(function () {
      if (note) note.textContent = 'Wallet balances are temporarily unavailable. Refresh the page to try again.';
    });
})(); + format(state.usd, 'USD');
      if (note) note.textContent = 'Showing your separate USD wallet balance.';
    } else {
      total.textContent = '₦' + format(state.ngn, 'NGN');
      if (note) note.textContent = 'Showing your separate NGN wallet balance.';
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