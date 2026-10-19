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
          error.status = response.status;
          // A 429 is a throttling response, not evidence that KYC is unapproved.
          // Do not retry it; the server still enforces KYC on protected routes.
          error.retryable = response.status >= 500 && response.status !== 429;
          throw error;
        }
        return response.json();
      })
      .then(function (data) {
        renderAccess(data && data.approved === true);
      })
      .catch(function (error) {
        if (error && error.status === 429) {
          // Avoid turning a temporary rate limit into a false KYC lock for an
          // already-approved member. Protected routes remain server-authorized.
          renderAccess(true);
          return;
        }
        // Retry only one transient 5xx response; avoid multiplying traffic.
        if (attempt < 1 && error && error.retryable === true) {
          window.setTimeout(function () { loadAccessStatus(attempt + 1); }, 1200);
          return;
        }
        // Only treat an explicit non-retryable status response as unapproved.
        if (error && error.status >= 400 && error.status < 500) {
          renderAccess(false);
        }
        // For network/server failures, preserve the existing navigation state.
      });
  }
  loadAccessStatus(0);
})();
