export type ShiftTimeeRange = {
  startTime: string;
  endTime: string;
};

export function parseShiftTimeeRange(value: string | null | undefined): ShiftTimeeRange {
  const match = String(value || "").trim().match(/^(\d{2}:\d{2})?-(\d{2}:\d{2})?$/);
  return {
    startTime: match?.[1] || "",
    endTime: match?.[2] || "",
  };
}

export function buildShiftTimeeRange(startTime: string, endTime: string) {
  if (!startTime && !endTime) return "";
  return `${startTime || ""}-${endTime || ""}`;
}

function normalizedHeadcount(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).normalize("NFKC").trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function shiftTimeeHeadcount(
  text: string | null | undefined,
  encodedRange: string | null | undefined,
  legacyCount?: number | string | null,
) {
  const storedCount = normalizedHeadcount(legacyCount);
  if (storedCount !== null) return storedCount;

  const normalizedText = String(text || "").normalize("NFKC").trim();
  const plainCount = normalizedHeadcount(normalizedText);
  if (plainCount !== null) return plainCount;

  const statedCount = normalizedText.match(/(\d+(?:\.\d+)?)\s*(?:名|人)/)?.[1];
  const parsedStatedCount = normalizedHeadcount(statedCount);
  if (parsedStatedCount !== null) return parsedStatedCount;

  const range = parseShiftTimeeRange(encodedRange);
  return normalizedText || range.startTime || range.endTime ? 1 : 0;
}

export function shiftTimeeDisplay(
  text: string | null | undefined,
  encodedRange: string | null | undefined,
  legacyCount?: number | string | null,
) {
  const rawRange = String(encodedRange || "").trim();
  const range = parseShiftTimeeRange(encodedRange);
  const timeLabel = range.startTime && range.endTime
    ? `${range.startTime}〜${range.endTime}`
    : range.startTime
      ? `${range.startTime}〜`
      : range.endTime
        ? `〜${range.endTime}`
        : "";
  return [
    String(text || "").trim() || (legacyCount === null || legacyCount === undefined || legacyCount === "" ? "" : String(legacyCount)),
    timeLabel || rawRange,
  ]
    .filter(Boolean)
    .join(" ");
}
