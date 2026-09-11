const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeCalendarEventColor(value: unknown, fallback = "#1a73e8") {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : fallback;
}

export function calendarEventTextColor(color: string) {
  const normalized = normalizeCalendarEventColor(color).slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness > 150 ? "#202124" : "#fff";
}
