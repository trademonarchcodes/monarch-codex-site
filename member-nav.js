(function () {
  'use strict';

  var links = Array.prototype.slice.call(document.querySelectorAll('nav a[data-kyc-locked="true"]'));
  if (!links.length) return;

  function renderAccess(approved) {
    links.forEach(function (link) {
      var badge = link.querySelector('.member-kyc-lock');
      if (approved === true) {
        link.removeAttribute('data-kyc-locked');
        link.removeAttribute('aria-disabled');
        link.href = link.getAttribute('data-member-href') || link.href;
        if (badge) badge.remove();
        link.classList.add('kyc-unlocked');
        return;
      }

      link.setAttribute('data-kyc-locked', 'true');
      link.setAttribute('aria-disabled', 'true');
      link.href = '/kyc?required=approval';
      link.classList.remove('kyc-unlocked');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'member-kyc-lock';
        badge.setAttribute('aria-label', 'Locked until KYC is approved');
        badge.setAttribute('title', 'Locked until KYC is approved');
        badge.textContent = '🔒';
        link.appendChild(badge);
      }
    });
  }

  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      if (link.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        window.location.assign('/kyc?required=approval');
      }
    });
  });

  // Retry transient edge/proxy errors before deciding that KYC is unapproved.
  // Keep the server-side KYC checks authoritative; this only refreshes navigation UI.
  function loadAccessStatus(attempt) {
    fetch('/api/kyc/access-status', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        if (!response.ok) {
          var error = new Error('KYC access status unavailable');
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return response.json();
      })
      .then(function (data) {
        renderAccess(data && data.approved === true);
      })
      .catch(function (error) {
        if (attempt < 2 && (!error || error.retryable !== false)) {
          window.setTimeout(function () { loadAccessStatus(attempt + 1); }, 900 * (attempt + 1));
          return;
        }
        renderAccess(false);
      });
  }
  loadAccessStatus(0);
})();
