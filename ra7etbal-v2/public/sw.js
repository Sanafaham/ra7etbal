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
    Promise.all([
      self.registration.showNotification(payload.title || "Ra7etBal reminder", {
        body: payload.body || "A reminder is due now.",
        icon: "/icons/ra7etbal-icon-192.png",
        badge: "/icons/ra7etbal-icon-180.png"
      }),
      // Tell any open tab a push arrived so it can refetch tasks — pushes
      // are sent for task state changes (completion, correction, escalation)
      // that happen outside the owner's own browser session, so an
      // already-open tab has no other way to learn its cached state is stale.
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
        clientList.forEach(function (client) {
          client.postMessage({ type: "ra7etbal:push-received" });
        });
      })
    ])
  );
});
