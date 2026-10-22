(function () {
  'use strict';
  if (window.__monarchAppShellReady) return;
  window.__monarchAppShellReady = true;

  // Monarch Codex is distributed as a website plus the official Android APK.
  // Stop registering the legacy PWA and retire any previously installed service worker.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      return Promise.all(registrations.map(function (registration) {
        return registration.unregister();
      }));
    }).catch(function () {});
  }
  if ('caches' in window) {
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key.indexOf('monarch-codex-pwa-') === 0;
      }).map(function (key) { return caches.delete(key); }));
    }).catch(function () {});
  }

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