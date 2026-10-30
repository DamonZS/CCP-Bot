import { currentLocale, type Locale } from "@/lib/i18n";

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

/**
 * One formatter per language, built on first use.
 *
 * `undefined` used to stand in for the language, which meant ICU picked the runtime's default: a
 * Chinese window on a machine whose locale was English said "2 minutes ago" next to the translated
 * sentences, and the CI machine's own default decided what a test saw. The app has one language in
 * hand at module load, so the timestamps follow the same one the words do.
 */
const formatters = new Map<Locale, Intl.RelativeTimeFormat>();

function formatterFor(locale: Locale): Intl.RelativeTimeFormat {
  const cached = formatters.get(locale);
  if (cached !== undefined) return cached;
  const built = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  formatters.set(locale, built);
  return built;
}

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
export function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = Date.now() - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return formatterFor(currentLocale()).format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}
