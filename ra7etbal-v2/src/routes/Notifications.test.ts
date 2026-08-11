import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(join(root, "routes", "Notifications.tsx"), "utf8");
const app = readFileSync(join(root, "App.tsx"), "utf8");
const bottomNav = readFileSync(join(root, "components", "nav", "BottomNav.tsx"), "utf8");

describe("Notifications Inbox V1 UI wiring", () => {
  it("adds a protected header-bell route without changing bottom navigation", () => {
    expect(app).toContain('<Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />');
    expect(app).toContain('to="/notifications"');
    expect(app).toContain('{showNav && (');
    expect(bottomNav).not.toContain('to="/notifications"');
  });

  it("renders durable notification truth and all required states", () => {
    expect(route).toContain("Notifications");
    expect(route).toContain("Mark all read");
    expect(route).toContain("Nothing new.");
    expect(route).toContain("Loading notifications");
    expect(route).toContain("Try again");
    expect(route).toContain("item.title");
    expect(route).toContain("item.body");
    expect(route).toContain("item.occurred_at");
    expect(route).toContain("await openOwnerNotification(item, { markRead, navigate })");
    expect(route).toContain("await markEveryOwnerNotificationRead(markAllRead)");
    expect(route).toContain("actionError");
  });

  it("keeps the bell count independent from What's Happening attention", () => {
    expect(app).toContain("selectUnreadNotificationCount");
    expect(bottomNav).toContain("brief.needsAttention.length + visible.length");
    expect(bottomNav).not.toContain("useNotificationsStore");
  });
});
