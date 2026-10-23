(function () {
  'use strict';

  var links = Array.prototype.slice.call(document.querySelectorAll('nav a[data-kyc-locked="true"]'));

  /* Section counts are informational only; all permissions remain server-enforced. */
  (function syncSectionCounts() {
    var badgeNodes = Array.prototype.slice.call(document.querySelectorAll('[data-member-nav-badge]'));
    if (!badgeNodes.length) return;
    var style = document.createElement('style');
    style.textContent = '.member-nav-link{position:relative}.member-nav-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;margin-left:auto;border-radius:99px;background:#e5484d;color:#fff;font:900 10px/1 system-ui,sans-serif;box-sizing:border-box}.member-nav-count[hidden]{display:none!important}';
    document.head.appendChild(style);
    var readKey = 'monarchCodexCommunityLastSeenPostId';
    function paint(key, count) {
      badgeNodes.forEach(function (badge) {
        if (badge.getAttribute('data-member-nav-badge') !== key) return;
        var value = Math.max(0, Number(count) || 0);
        badge.textContent = value > 99 ? '99+' : String(value);
        badge.hidden = value === 0;
        var link = badge.closest('a');
        if (link) {
          var label = link.querySelector('.member-nav-label');
          link.setAttribute('aria-label', (label ? label.textContent.trim() : key) + (value ? ', ' + value + ' new items' : ''));
        }
      });
    }
    function unreadBy(items, category) {
      return items.filter(function (item) {
        if (item.readAt != null) return false;
        var type = String(item.type || '').toLowerCase();
        if (category === 'wallet') return /deposit|withdraw|transaction|wallet/.test(type);
        if (category === 'invest') return /invest/.test(type);
        if (category === 'profile') return /kyc|role|profile/.test(type);
        if (category === 'sovereign') return /sovereign|signal|guidance/.test(type);
        if (category === 'community') return /community/.test(type);
        return false;
      }).length;
    }
    async function refresh() {
      try {
        var results = await Promise.all([
          fetch('/api/mobile/notifications', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }),
          fetch('/api/mobile/community/posts', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        ]);
        if (!results[0].ok || !results[1].ok) return;
        var notifications = await results[0].json();
        var community = await results[1].json();
        var items = Array.isArray(notifications.items) ? notifications.items : [];
        ['wallet', 'invest', 'profile', 'sovereign'].forEach(function (category) {
          paint(category, unreadBy(items, category));
        });
        var posts = Array.isArray(community.items) ? community.items : [];
        var ids = posts.map(function (post) { return Number(post.id) || 0; }).filter(function (id) { return id > 0; });
        var latest = ids.length ? Math.max.apply(Math, ids) : 0;
        var marker = null;
        try {
          var raw = window.sessionStorage.getItem(readKey);
          if (raw !== null && raw !== '') marker = Number(raw);
        } catch (_) {}
        if (marker === null || !Number.isFinite(marker) || window.location.pathname === '/community') {
          marker = latest;
          try { window.sessionStorage.setItem(readKey, String(latest)); } catch (_) {}
        }
        paint('community', ids.filter(function (id) { return id > marker; }).length + unreadBy(items, 'community'));
      } catch (_) {
        // Keep existing badge state if the service is temporarily unavailable.
      }
    }
    refresh();
    window.setInterval(function () { if (!document.hidden) refresh(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('pageshow', refresh);
  })();

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
