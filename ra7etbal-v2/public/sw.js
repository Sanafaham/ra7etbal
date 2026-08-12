/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
var RA7ETBAL_SW_VERSION = "reminder-delivery-v1";

function reportDelivery(receipt, stage, detail) {
  if (!receipt || !receipt.url) return Promise.resolve();
  return fetch(receipt.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "notification-receipt",
      // Omitted (undefined) for any receipt that doesn't set it — the
      // server already defaults a missing kind to "reminder", so this is
      // backward compatible with every already-cached copy of this file.
      kind: receipt.kind,
      taskId: receipt.taskId,
      subscriptionId: receipt.subscriptionId,
      dueAt: receipt.dueAt,
      token: receipt.token,
      stage: stage,
      detail: detail || null,
      swVersion: RA7ETBAL_SW_VERSION
    })
  }).catch(function () {});
}

function safeInternalRoute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/notifications";
  }
  try {
    var resolved = new URL(value, self.location.origin);
    if (resolved.origin !== self.location.origin) return "/notifications";
    return resolved.pathname + resolved.search + resolved.hash;
  } catch (_error) {
    return "/notifications";
  }
}
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", function (event) {
  var receipt = event.notification.data && event.notification.data.receipt;
  var targetUrl = safeInternalRoute(event.notification.data && event.notification.data.url);
  event.notification.close();
  event.waitUntil(
    reportDelivery(receipt, "notification_clicked").then(function () {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true });
    }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url && "focus" in client) {
          if ("navigate" in client) {
            return client.navigate(targetUrl).then(function (navigatedClient) {
              return (navigatedClient || client).focus();
            });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// Fires when the browser proactively rotates or expires this subscription
// (endpoint/key change) without the page being open. Without this handler
// the old, now-dead endpoint is left in push_subscriptions forever — the
// provider often keeps accepting sends to it long before ever returning a
// hard 404/410, so the app has no other signal a rotation happened.
// event.oldSubscription.options.applicationServerKey lets us resubscribe
// with the exact same VAPID key used originally, so this file never needs
// its own copy of that key. If the browser doesn't supply oldSubscription
// (some engines don't), there is no safe way to resubscribe here — no-op.
self.addEventListener("pushsubscriptionchange", function (event) {
  var oldSubscription = event.oldSubscription;
  var applicationServerKey = oldSubscription && oldSubscription.options
    ? oldSubscription.options.applicationServerKey
    : null;
  if (!applicationServerKey) return;

  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey })
      .then(function (newSubscription) {
        return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
          clientList.forEach(function (client) {
            client.postMessage({
              type: "ra7etbal:push-subscription-changed",
              subscription: newSubscription.toJSON(),
              oldEndpoint: oldSubscription ? oldSubscription.endpoint : null
            });
          });
        });
      })
      .catch(function () {})
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

  var receipt = payload.receipt;
  var show = reportDelivery(receipt, "service_worker_received")
    .then(function () { return reportDelivery(receipt, "show_notification_attempted"); })
    .then(function () {
      return self.registration.showNotification(payload.title || "Ra7etBal reminder", {
        body: payload.body || "A reminder is due now.",
        icon: "/icons/ra7etbal-icon-192.png",
        badge: "/icons/ra7etbal-icon-180.png",
        data: {
          receipt: receipt,
          notificationId: payload.notificationId,
          url: safeInternalRoute(payload.url)
        }
      });
    })
    .then(function () { return reportDelivery(receipt, "show_notification_resolved"); })
    .catch(function (error) {
      return reportDelivery(receipt, "show_notification_failed", error && error.name ? error.name : "Error");
    });

  event.waitUntil(
    Promise.allSettled([
      show,
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
