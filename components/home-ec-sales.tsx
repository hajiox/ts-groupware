"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tag } from "lucide-react";
import { calendarEventTextColor, normalizeCalendarEventColor } from "@/lib/calendar-event-color";
import styles from "./home-ec-sales.module.css";

type SalesResponse = {
  date: string;
  sales: { id: string; label: string; color: string }[];
  warning: string | null;
};

export function HomeEcSales() {
  const [data, setData] = useState<SalesResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let busy = false;
    const controller = new AbortController();
    async function refresh() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch("/api/home/ec-sales", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const result: SalesResponse = await response.json();
        if (active) { setData(result); setError(""); }
      } catch {
        if (active) { setData(null); setError("ECセール情報を取得できませんでした。"); }
      } finally {
        busy = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return (
    <section className={styles.card} aria-label="本日のECセール情報">
      <div className={styles.header}>
        <h2><Tag size={17} aria-hidden="true" />本日のECセール</h2>
        <Link href="/calendar">カレンダーを見る</Link>
      </div>
      <div aria-live="polite">
        {data && <p className={styles.date}>{Number(data.date.slice(5, 7))}月{Number(data.date.slice(8, 10))}日</p>}
        {error ? <p className={styles.note}>{error}</p> : !data ? <p className={styles.note}>読み込み中…</p> : (
          <>
            {data.sales.length ? <ul className={styles.sales}>
              {data.sales.map(sale => {
                const color = normalizeCalendarEventColor(sale.color);
                return <li key={sale.id} style={{ backgroundColor: color, color: calendarEventTextColor(color) }}>{sale.label}</li>;
              })}
            </ul> : <p className={styles.note}>{data.warning ? "保存済みのセール情報はありません。" : "本日のECセール予定はありません。"}</p>}
            {data.warning && <p className={styles.note}>{data.warning}</p>}
          </>
        )}
      </div>
    </section>
  );
}
