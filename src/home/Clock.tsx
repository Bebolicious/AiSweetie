import { createSignal, onCleanup } from "solid-js";

function weekNumber(d: Date): number {
  // ISO-8601: week 1 is the week containing the first Thursday.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
}

export function Clock() {
  const [now, setNow] = createSignal(new Date());
  const timer = setInterval(() => setNow(new Date()), 1000);
  onCleanup(() => clearInterval(timer));

  const time = () =>
    now().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  const date = () =>
    now().toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

  return (
    <div class="panel clock" data-focused="true" style={{ "--accent": "var(--teal)" }}>
      <div class="clock__row">
        <span class="clock__time">{time()}</span>
        <span class="clock__meta">
          {date()}
          <br />
          week {weekNumber(now())}
        </span>
      </div>
    </div>
  );
}
