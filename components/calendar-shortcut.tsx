"use client";

import Link from "next/link";
import { CalendarDays } from "lucide-react";

export function CalendarShortcut() {
  return (
    <Link href="/calendar" className="calendar-shortcut" aria-label="カレンダーを開く" title="カレンダー">
      <CalendarDays size={19} strokeWidth={2.1} aria-hidden="true" />
    </Link>
  );
}
