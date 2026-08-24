export type PledgeReminderLevel = "pending" | "warning" | "final";

export const PLEDGE_WARNING_DAYS = 7;
export const PLEDGE_FINAL_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function pledgeElapsedDays(sentAt: string, now = Date.now()) {
  const sentTime = Date.parse(sentAt);
  if (!Number.isFinite(sentTime)) return 0;
  return Math.max(0, Math.floor((now - sentTime) / DAY_MS));
}

export function pledgeReminderInfo(sentAt: string, isTest = false, now = Date.now()) {
  const elapsedDays = pledgeElapsedDays(sentAt, now);

  if (isTest) {
    return {
      level: "pending" as const,
      elapsedDays,
      eyebrow: "テスト誓約書",
      headline: "テスト誓約書が届いています",
      detail: "表示と提出の流れを確認してください。",
    };
  }

  if (elapsedDays >= PLEDGE_FINAL_WARNING_DAYS) {
    return {
      level: "final" as const,
      elapsedDays,
      eyebrow: "最終警告",
      headline: "誓約書が14日以上未提出です",
      detail: "至急提出してください。提出がない場合、次回シフトから勤務できません。",
    };
  }

  if (elapsedDays >= PLEDGE_WARNING_DAYS) {
    return {
      level: "warning" as const,
      elapsedDays,
      eyebrow: "提出警告",
      headline: "誓約書が7日以上未提出です",
      detail: "未提出の誓約書があります。内容を確認し、速やかに提出してください。",
    };
  }

  return {
    level: "pending" as const,
    elapsedDays,
    eyebrow: "重要・要確認",
    headline: "誓約書が届いています",
    detail: "内容を確認し、誓約書を提出してください。",
  };
}

export function pledgeReminderRank(level: PledgeReminderLevel) {
  if (level === "final") return 2;
  if (level === "warning") return 1;
  return 0;
}
