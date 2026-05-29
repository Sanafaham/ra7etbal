export function formatReminderDue(value: string | null, now = new Date()): string | null {
  if (!value) return null;
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return null;

  const diffMs = due.getTime() - now.getTime();
  if (diffMs < 0) return formatOverdue(diffMs);

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `Due in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

  const hours = Math.ceil(diffMs / 3_600_000);
  if (isSameLocalDay(due, now) && hours <= 3) {
    return `Due in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  if (isSameLocalDay(due, now)) {
    return `Due today at ${formatTime(due)}`;
  }

  if (isTomorrow(due, now)) {
    return `Tomorrow at ${formatTime(due)}`;
  }

  if (isWithinNextSixDays(due, now)) {
    return `${formatWeekday(due)} at ${formatTime(due)}`;
  }

  return `${formatDate(due)} at ${formatTime(due)}`;
}

export function isReminderOverdue(value: string | null, now = new Date()): boolean {
  if (!value) return false;
  const due = new Date(value);
  return !Number.isNaN(due.getTime()) && due.getTime() < now.getTime();
}

function formatOverdue(diffMs: number): string {
  const overdueMs = Math.abs(diffMs);
  const minutes = Math.floor(overdueMs / 60_000);
  if (minutes < 60) {
    const value = Math.max(1, minutes);
    return `Overdue by ${value} ${value === 1 ? "minute" : "minutes"}`;
  }

  const hours = Math.floor(overdueMs / 3_600_000);
  if (hours < 24) {
    return `Overdue by ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  const days = Math.floor(overdueMs / 86_400_000);
  return `Overdue by ${days} ${days === 1 ? "day" : "days"}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isTomorrow(date: Date, now: Date): boolean {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return isSameLocalDay(date, tomorrow);
}

function isWithinNextSixDays(date: Date, now: Date): boolean {
  const start = startOfLocalDay(now).getTime();
  const target = startOfLocalDay(date).getTime();
  const days = Math.floor((target - start) / 86_400_000);
  return days > 1 && days <= 6;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatWeekday(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long" });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
