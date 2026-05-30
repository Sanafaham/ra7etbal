/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var payload = {};

  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_error) {
      payload = {};
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Ra7etBal reminder", {
      body: payload.body || "A reminder is due now.",
      icon: "/icons/ra7etbal-icon-192.png",
      badge: "/icons/ra7etbal-icon-180.png"
    })
  );
});
