import type { CalendarEvent } from "../../lib/calendar";

interface AwarenessItem {
  id: string;
  label: string;
  bucket: "today" | "tomorrow" | "week";
}

const BUCKET_LABELS: Record<AwarenessItem["bucket"], string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This Week",
};

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function diffDays(a: Date, b: Date): number {
  return Math.round(
    (startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000,
  );
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function buildAwarenessItems(
  events: CalendarEvent[],
  now: Date,
  max = 3,
): AwarenessItem[] {
  const todayStart = startOfDay(now);
  const items: AwarenessItem[] = [];

  const sorted = [...events].sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return ta - tb;
  });

  for (const ev of sorted) {
    if (items.length >= max) break;

    const startDate = ev.start ? new Date(ev.start) : null;

    // Skip events with no start.
    if (!startDate || Number.isNaN(startDate.getTime())) continue;

    // Skip timed events that have already ended today.
    if (!ev.allDay && ev.end) {
      const endDate = new Date(ev.end);
      if (!Number.isNaN(endDate.getTime()) && endDate < now) continue;
    }

    const dayDiff = diffDays(startDate, todayStart);

    let bucket: AwarenessItem["bucket"];
    if (dayDiff === 0) bucket = "today";
    else if (dayDiff === 1) bucket = "tomorrow";
    else if (dayDiff >= 2 && dayDiff <= 6) bucket = "week";
    else continue; // beyond this week

    let label: string;
    if (ev.allDay) {
      label = ev.title;
    } else {
      const time = formatTime(ev.start!);
      label = time ? `${ev.title} at ${time}` : ev.title;
    }

    items.push({ id: ev.id, label, bucket });
  }

  return items;
}

interface AwarenessCardProps {
  events: CalendarEvent[];
  now: Date;
}

export default function AwarenessCard({ events, now }: AwarenessCardProps) {
  const items = buildAwarenessItems(events, now);

  if (items.length === 0) return null;

  // Group into buckets preserving order.
  const groups: { bucket: AwarenessItem["bucket"]; items: AwarenessItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.bucket === item.bucket) {
      last.items.push(item);
    } else {
      groups.push({ bucket: item.bucket, items: [item] });
    }
  }

  return (
    <section
      data-testid="awareness-card"
      aria-label="Next Up"
      className="mt-6 sm:mt-8"
    >
      <p data-testid="awareness-card-heading" className="mb-3 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/75">
        Next Up
      </p>

      <div data-testid="awareness-card-surface" className="rounded-[20px] border border-border bg-warm-white/60 px-4 py-4 space-y-4 shadow-[0_12px_36px_-26px_rgba(20,20,20,0.18)] backdrop-blur-sm">
        {groups.map((group) => (
          <div key={group.bucket} data-testid={`awareness-bucket-${group.bucket}`}>
            <p data-testid={`awareness-bucket-label-${group.bucket}`} className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink/55">
              {BUCKET_LABELS[group.bucket]}
            </p>
            <ul className="mt-1.5 space-y-1">
              {group.items.map((item) => (
                <li
                  key={item.id}
                  data-testid={`awareness-event-${item.id}`}
                  className="text-[14px] leading-relaxed text-text"
                >
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
