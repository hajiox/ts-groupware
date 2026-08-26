"use client";

import Link from "next/link";
import {
  AtSign,
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Heart,
  ListTodo,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import styles from "./notifications.module.css";

type NotificationType = "mention" | "task" | "reaction" | "comment";
type NotificationFilter = "all" | NotificationType;

type NotificationItem = {
  event_key: string;
  event_type: NotificationType;
  actor_name: string;
  group_name: string | null;
  title: string;
  summary: string;
  url: string;
  created_at: string;
  due_date: string | null;
  completed_at: string | null;
  emoji: string | null;
  is_unread: boolean;
};

const FILTERS: Array<{ value: NotificationFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "mention", label: "メンション" },
  { value: "task", label: "タスク" },
  { value: "reaction", label: "リアクション" },
  { value: "comment", label: "コメント" },
];

const TYPE_META = {
  mention: { label: "メンション", Icon: AtSign, tone: styles.typeIconMention },
  task: { label: "タスク", Icon: ListTodo, tone: styles.typeIconTask },
  reaction: { label: "リアクション", Icon: Heart, tone: styles.typeIconReaction },
  comment: { label: "コメント", Icon: MessageCircle, tone: styles.typeIconComment },
} satisfies Record<NotificationType, { label: string; Icon: typeof Bell; tone: string }>;

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDueDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
}

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadNotifications() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications/center", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "通知を取得できませんでした");

      const nextItems = (data.items || []) as NotificationItem[];
      setItems(nextItems);

      if (data.unreadCount > 0 && data.latestCreatedAt) {
        const markResponse = await fetch("/api/notifications/center", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read_through: data.latestCreatedAt }),
        });
        if (markResponse.ok) {
          setItems(current => current.map(item => ({ ...item, is_unread: false })));
          window.dispatchEvent(new Event("tsg:notification-refresh"));
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "通知を取得できませんでした");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotifications();
  }, []);

  const filteredItems = useMemo(
    () => filter === "all" ? items : items.filter(item => item.event_type === filter),
    [filter, items],
  );

  return (
    <>
      <header className="top-header" role="banner">
        <Link href="/groups" className="top-header__back" aria-label="ホームに戻る">
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <h1 className="top-header__title">通知</h1>
        <button
          type="button"
          className="top-header__icon"
          onClick={() => void loadNotifications()}
          disabled={loading}
          aria-label="通知を更新"
          title="更新"
        >
          <RefreshCw size={18} className={loading ? styles.spinning : undefined} aria-hidden="true" />
        </button>
      </header>

      <main className={styles.page}>
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>Notification Center</span>
            <h2>自分に関係する更新</h2>
          </div>
          <span className={styles.total}>{items.length}件</span>
        </div>

        <div className={styles.filters} role="tablist" aria-label="通知の種類">
          {FILTERS.map(option => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              className={filter === option.value ? styles.filterActive : styles.filter}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <section className={styles.list} aria-live="polite" aria-busy={loading}>
          {loading && items.length === 0 ? (
            <p className={styles.state}>読み込み中...</p>
          ) : error ? (
            <div className={styles.error} role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void loadNotifications()}>再読み込み</button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className={styles.empty}>
              <Bell size={30} aria-hidden="true" />
              <p>{filter === "all" ? "通知はまだありません。" : "この種類の通知はありません。"}</p>
            </div>
          ) : filteredItems.map(item => {
            const meta = TYPE_META[item.event_type];
            const Icon = meta.Icon;
            return (
              <Link key={item.event_key} href={item.url || "/groups"} className={styles.item}>
                <span className={`${styles.typeIcon} ${meta.tone}`} aria-hidden="true">
                  {item.event_type === "reaction" && item.emoji
                    ? <span className={styles.emoji}>{item.emoji}</span>
                    : <Icon size={19} />}
                </span>
                <span className={styles.itemMain}>
                  <span className={styles.itemHeader}>
                    <span className={styles.itemTitle}>{item.title}</span>
                    <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
                  </span>
                  <span className={styles.actor}>{item.actor_name}</span>
                  <span className={styles.summary}>{item.summary}</span>
                  <span className={styles.meta}>
                    {item.group_name && <span>{item.group_name}</span>}
                    {item.event_type === "task" && item.due_date && (
                      <span className={item.completed_at ? styles.taskDone : styles.taskDue}>
                        {item.completed_at ? <CheckCircle2 size={13} /> : <ListTodo size={13} />}
                        {item.completed_at ? "完了" : `期限 ${formatDueDate(item.due_date)}`}
                      </span>
                    )}
                  </span>
                </span>
                <ChevronRight size={18} className={styles.chevron} aria-hidden="true" />
              </Link>
            );
          })}
        </section>
      </main>
    </>
  );
}
