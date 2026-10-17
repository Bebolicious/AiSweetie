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

  /**
   * Tick on the minute, not the second.
   *
   * Nothing here renders seconds — the display is HH:MM, a date and a week
   * number — so a 1Hz interval was 59 updates a minute that wrote back the
   * same strings, forever, including while you are looking at a terminal on
   * the far side of the world.
   *
   * Each timeout is measured from the real clock rather than chained at a
   * fixed 60s, so this re-aligns itself after the machine sleeps instead of
   * drifting a little further from the minute boundary every hour.
   */
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const d = new Date();
    setNow(d);
    const toNextMinute = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds());
    // A small margin, so a timeout that fires a hair early does not land in
    // the same minute and wait a whole minute more to correct.
    timer = setTimeout(tick, toNextMinute + 50);
  };
  tick();
  onCleanup(() => clearTimeout(timer));

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
