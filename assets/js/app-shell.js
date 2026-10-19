(function () {
  'use strict';
  if (window.__monarchAppShellReady) return;
  window.__monarchAppShellReady = true;

  var head = document.head;
  if (!head.querySelector('link[rel="manifest"]')) {
    var manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = '/manifest.webmanifest';
    head.appendChild(manifest);
  }
  function meta(name, value, attribute) {
    var selector = 'meta[' + (attribute || 'name') + '="' + name + '"]';
    var node = head.querySelector(selector);
    if (!node) { node = document.createElement('meta'); node.setAttribute(attribute || 'name', name); head.appendChild(node); }
    node.content = value;
  }
  meta('theme-color', '#0b0b0c');
  meta('mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-capable', 'yes');
  meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  meta('apple-mobile-web-app-title', 'Monarch Codex');

  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) document.documentElement.classList.add('monarch-app-mode');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
        .then(function (registration) {
          registration.update().catch(function () {});
        })
        .catch(function () {});
    }, { once: true });
  }

  var installEvent = null;
  var installButton = null;
  function hideInstallButton() {
    if (installButton) installButton.remove();
    installButton = null;
  }
  function showInstallButton() {
    if (standalone || installButton || !installEvent) return;
    installButton = document.createElement('button');
    installButton.type = 'button';
    installButton.textContent = '＋ Install Monarch Codex';
    installButton.setAttribute('aria-label', 'Install Monarch Codex app');
    installButton.style.cssText = 'position:fixed;z-index:12000;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));max-width:calc(100vw - 32px);min-height:48px;padding:0 18px;border:1px solid #ffe6a0;border-radius:999px;background:linear-gradient(110deg,#ffe28a,#e7b83f);color:#17140a;font:800 14px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px #0007;cursor:pointer;touch-action:manipulation';
    installButton.addEventListener('click', async function () {
      if (!installEvent) return;
      installEvent.prompt();
      try { await installEvent.userChoice; } catch (_) {}
      installEvent = null;
      hideInstallButton();
    });
    document.body.appendChild(installButton);
  }
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installEvent = event;
    showInstallButton();
  });
  window.addEventListener('appinstalled', function () {
    installEvent = null;
    hideInstallButton();
    document.documentElement.classList.add('monarch-app-mode');
  });

  // Avoid duplicate form submissions on slow mobile connections, a common cause
  // of accidental login/registration retries. The server still enforces security limits.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.mcSubmitting === 'true') {
      if (form instanceof HTMLFormElement) event.preventDefault();
      return;
    }
    var submit = event.submitter || form.querySelector('button[type="submit"],input[type="submit"]');
    if (!submit || form.dataset.mcAllowRepeat === 'true') return;
    form.dataset.mcSubmitting = 'true';
    if (submit.tagName === 'BUTTON') {
      submit.dataset.mcOriginalText = submit.textContent;
      submit.textContent = 'Please wait…';
    }
    submit.disabled = true;
    window.setTimeout(function () {
      if (!form.isConnected) return;
      delete form.dataset.mcSubmitting;
      submit.disabled = false;
      if (submit.dataset.mcOriginalText) submit.textContent = submit.dataset.mcOriginalText;
    }, 15000);
  }, true);
})();