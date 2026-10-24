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
    var rate = Number(state.rate);
    var hasRate = Number.isFinite(rate) && rate > 0;

    if (hasRate) {
      // Treat the NGN and USD wallet amounts as one combined value,
      // expressed in whichever display currency the member selects.
      var totalNgn = state.ngn + (state.usd * rate);
      var totalUsd = totalNgn / rate;

      if (selector.value === 'USD') {
        total.textContent = '$' + format(totalUsd, 'USD');
      } else {
        total.textContent = '₦' + format(totalNgn, 'NGN');
      }

      if (note) {
        note.textContent = 'Your total wallet value, shown in the selected currency. Switching currencies changes the display only.';
      }
      return;
    }

    // Do not silently show an incomplete conversion when the FX rate is unavailable.
    total.textContent = '—';
    if (note) {
      note.textContent = 'Your wallet value will appear when the exchange rate is available.';
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

  fetch('/api/wallet-balances', {
    credentials: 'same-origin',
    cache: 'no-store'
  })
    .then(function (response) {
      if (!response.ok) throw new Error('Wallet balance request failed');
      return response.json();
    })
    .then(function (data) {
      // The API's ngn/usd fields are already combined equivalents. Use actual stored
      // currency balances here so render() combines each wallet exactly once.
      state.ngn = Number(data.actualNgn !== undefined ? data.actualNgn : data.ngn) || 0;
      state.usd = Number(data.actualUsd !== undefined ? data.actualUsd : data.usd) || 0;
      state.rate = Number(data.rate) > 0 ? Number(data.rate) : null;
      render();
    })
    .catch(function () {
      total.textContent = '—';
      if (note) note.textContent = 'Wallet value is temporarily unavailable. Please refresh and try again.';
    });
})();