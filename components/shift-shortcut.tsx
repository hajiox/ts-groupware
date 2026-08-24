"use client";

import Link from "next/link";
import { CalendarCheck } from "lucide-react";

export function ShiftShortcut() {
  return (
    <Link href="/shifts" className="calendar-shortcut shift-shortcut" aria-label="シフトを開く" title="シフト">
      <CalendarCheck size={19} strokeWidth={2.1} aria-hidden="true" />
    </Link>
  );
}
