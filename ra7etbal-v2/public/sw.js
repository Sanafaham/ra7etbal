/* Ra7etBal service worker: intentionally tiny classic JS for iOS Safari. */
var RA7ETBAL_SW_VERSION = "reminder-delivery-v1";

function reportDelivery(receipt, stage, detail) {
  if (!receipt || !receipt.url) return Promise.resolve();
  return fetch(receipt.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "notification-receipt",
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
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", function (event) {
  var receipt = event.notification.data && event.notification.data.receipt;
  event.notification.close();
  event.waitUntil(
    reportDelivery(receipt, "notification_clicked").then(function () {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true });
    }).then(function (clientList) {
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

  var receipt = payload.receipt;
  var show = reportDelivery(receipt, "service_worker_received")
    .then(function () { return reportDelivery(receipt, "show_notification_attempted"); })
    .then(function () {
      return self.registration.showNotification(payload.title || "Ra7etBal reminder", {
        body: payload.body || "A reminder is due now.",
        icon: "/icons/ra7etbal-icon-192.png",
        badge: "/icons/ra7etbal-icon-180.png",
        data: { receipt: receipt }
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
