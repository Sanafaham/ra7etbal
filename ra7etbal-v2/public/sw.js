/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function () {
  /* Push sending is not implemented in Slice 2. */
});
