/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  event.waitUntil(
    self.registration.showNotification("Ra7etBal test", {
      body: "Push reached the service worker.",
      icon: "/icons/ra7etbal-icon-192.png",
      badge: "/icons/ra7etbal-icon-180.png"
    })
  );
});
