/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/");
      }
    })
  );
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
