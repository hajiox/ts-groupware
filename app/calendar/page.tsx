"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import styles from "./calendar.module.css";

type CalendarUser = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  color: string;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  creator: CalendarUser | null;
};

type EventForm = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  color: string;
  location: string;
  description: string;
};

const WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const EVENT_COLORS = ["#1a73e8", "#0b8043", "#f4511e", "#8e24aa", "#d93025", "#fbbc04", "#00897b"];

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function startOfWeek(date: Date) {
  return addDays(date, -date.getDay());
}

function dateKey(date: Date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function timeValue(date: Date) {
  return `${date.getHours()}`.padStart(2, "0") + ":" + `${date.getMinutes()}`.padStart(2, "0");
}

function monthLabel(date: Date) {
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "long" });
}

function selectedDateLabel(date: Date) {
  return date.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function buildMonthDays(month: Date) {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

function eventOverlapsDay(event: CalendarEvent, day: Date) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = addDays(dayStart, 1);
  return new Date(event.starts_at) < dayEnd && new Date(event.ends_at) > dayStart;
}

function compareEvents(a: CalendarEvent, b: CalendarEvent) {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
}

function formatEventTime(event: CalendarEvent) {
  if (event.all_day) return "終日";
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  return `${timeValue(start)}-${timeValue(end)}`;
}

function defaultForm(day: Date): EventForm {
  const isToday = isSameDay(day, new Date());
  const startHour = isToday ? Math.min(new Date().getHours() + 1, 18) : 9;
  const endHour = Math.min(startHour + 1, 23);

  return {
    title: "",
    date: dateKey(day),
    startTime: `${startHour}`.padStart(2, "0") + ":00",
    endTime: `${endHour}`.padStart(2, "0") + ":00",
    allDay: false,
    color: EVENT_COLORS[0],
    location: "",
    description: "",
  };
}

function formFromEvent(event: CalendarEvent): EventForm {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);

  return {
    title: event.title,
    date: dateKey(start),
    startTime: timeValue(start),
    endTime: event.all_day ? "18:00" : timeValue(end),
    allDay: event.all_day,
    color: EVENT_COLORS.includes(event.color) ? event.color : EVENT_COLORS[0],
    location: event.location || "",
    description: event.description || "",
  };
}

export default function CalendarPage() {
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [form, setForm] = useState<EventForm>(() => defaultForm(new Date()));

  const monthDays = useMemo(() => buildMonthDays(visibleMonth), [visibleMonth]);
  const todayKey = dateKey(new Date());
  const selectedKey = dateKey(selectedDate);

  const range = useMemo(() => {
    const rangeStart = new Date(monthDays[0].getFullYear(), monthDays[0].getMonth(), monthDays[0].getDate()).toISOString();
    const last = monthDays[monthDays.length - 1];
    const rangeEnd = addDays(new Date(last.getFullYear(), last.getMonth(), last.getDate()), 1).toISOString();
    return { rangeStart, rangeEnd };
  }, [monthDays]);

  function loadEvents() {
    setLoading(true);
    setError("");

    const params = new URLSearchParams({
      range_start: range.rangeStart,
      range_end: range.rangeEnd,
    });

    fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" })
      .then((res) => res.ok ? res.json() : res.json().then((data) => Promise.reject(new Error(data.error || "予定を取得できませんでした"))))
      .then((data) => setEvents((data.events || []).sort(compareEvents)))
      .catch((err) => setError(err instanceof Error ? err.message : "予定を取得できませんでした"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.rangeStart, range.rangeEnd]);

  const selectedEvents = useMemo(() => (
    events.filter(event => eventOverlapsDay(event, selectedDate)).sort(compareEvents)
  ), [events, selectedDate]);

  function openCreate(day = selectedDate) {
    setSelectedDate(day);
    setEditingEvent(null);
    setForm(defaultForm(day));
    setEditorOpen(true);
  }

  function openEdit(event: CalendarEvent) {
    const eventStart = new Date(event.starts_at);
    setSelectedDate(eventStart);
    setEditingEvent(event);
    setForm(formFromEvent(event));
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditingEvent(null);
    setSaving(false);
  }

  function buildPayload() {
    const day = dateFromKey(form.date);
    let startsAt: Date;
    let endsAt: Date;

    if (form.allDay) {
      startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0);
      endsAt = addDays(startsAt, 1);
    } else {
      startsAt = new Date(`${form.date}T${form.startTime}`);
      endsAt = new Date(`${form.date}T${form.endTime}`);
    }

    if (!form.title.trim()) throw new Error("タイトルを入力してください");
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
      throw new Error("日時を確認してください");
    }

    return {
      id: editingEvent?.id,
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      all_day: form.allDay,
      color: form.color,
    };
  }

  async function saveEvent(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const payload = buildPayload();
      const res = await fetch("/api/calendar/events", {
        method: editingEvent ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "予定を保存できませんでした");

      closeEditor();
      loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "予定を保存できませんでした");
      setSaving(false);
    }
  }

  async function deleteEvent() {
    if (!editingEvent || !confirm("この予定を削除しますか？")) return;

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/calendar/events?id=${encodeURIComponent(editingEvent.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "予定を削除できませんでした");
      closeEditor();
      loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "予定を削除できませんでした");
      setSaving(false);
    }
  }

  function goToday() {
    const today = new Date();
    setVisibleMonth(startOfMonth(today));
    setSelectedDate(today);
  }

  return (
    <main className={styles.calendarShell}>
      <header className={styles.calendarHeader}>
        <Link href="/groups" className={styles.calendarBrand} aria-label="TS Groupwareへ戻る">
          <span className={styles.brandIcon} aria-hidden="true"><CalendarDays size={20} /></span>
          <span>
            <strong>TSG Calendar</strong>
            <small>予定管理</small>
          </span>
        </Link>

        <div className={styles.headerToolbar}>
          <button type="button" className={styles.iconButton} onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))} title="前の月">
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <button type="button" className={styles.todayButton} onClick={goToday}>今日</button>
          <button type="button" className={styles.iconButton} onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))} title="次の月">
            <ChevronRight size={20} aria-hidden="true" />
          </button>
          <h1 className={styles.monthTitle}>{monthLabel(visibleMonth)}</h1>
          <button type="button" className={styles.createButton} onClick={() => openCreate()}>
            <Plus size={18} aria-hidden="true" />
            <span>予定</span>
          </button>
        </div>
      </header>

      <section className={styles.calendarBody}>
        <section className={styles.monthPanel} aria-label="月間カレンダー">
          <div className={styles.weekHeader}>
            {WEEK_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className={styles.monthGrid}>
            {monthDays.map((day) => {
              const key = dateKey(day);
              const dayEvents = events.filter(event => eventOverlapsDay(event, day)).sort(compareEvents);
              const isCurrentMonth = day.getMonth() === visibleMonth.getMonth();
              const isToday = key === todayKey;
              const isSelected = key === selectedKey;

              return (
                <div
                  key={key}
                  className={[
                    styles.dayCell,
                    isCurrentMonth ? "" : styles.dayCellOutside,
                    isToday ? styles.dayCellToday : "",
                    isSelected ? styles.dayCellSelected : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setSelectedDate(day)}
                >
                  <div className={styles.dayCellTop}>
                    <button
                      type="button"
                      className={styles.dayNumber}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedDate(day);
                      }}
                    >
                      {day.getDate()}
                    </button>
                    <button
                      type="button"
                      className={styles.dayAdd}
                      title="予定を追加"
                      onClick={(event) => {
                        event.stopPropagation();
                        openCreate(day);
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className={styles.dayEvents}>
                    {dayEvents.slice(0, 4).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={styles.eventPill}
                        style={{ "--event-color": item.color } as React.CSSProperties}
                        onClick={(event) => {
                          event.stopPropagation();
                          openEdit(item);
                        }}
                        title={item.title}
                      >
                        <span>{formatEventTime(item)}</span>
                        <strong>{item.title}</strong>
                      </button>
                    ))}
                    {dayEvents.length > 4 && (
                      <span className={styles.moreEvents}>他 {dayEvents.length - 4} 件</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className={styles.agendaPanel} aria-label="選択日の予定">
          <div className={styles.agendaHeader}>
            <div>
              <span className={styles.agendaKicker}>選択中</span>
              <h2>{selectedDateLabel(selectedDate)}</h2>
            </div>
            <button type="button" className={styles.iconButton} onClick={() => openCreate(selectedDate)} title="予定を追加">
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>

          {error && <p className={styles.errorText}>{error}</p>}
          {loading ? (
            <p className={styles.emptyText}>読み込み中...</p>
          ) : selectedEvents.length === 0 ? (
            <p className={styles.emptyText}>予定はありません</p>
          ) : (
            <div className={styles.agendaList}>
              {selectedEvents.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  className={styles.agendaItem}
                  style={{ "--event-color": event.color } as React.CSSProperties}
                  onClick={() => openEdit(event)}
                >
                  <span className={styles.agendaColor} aria-hidden="true" />
                  <span className={styles.agendaContent}>
                    <strong>{event.title}</strong>
                    <span><Clock size={13} aria-hidden="true" />{formatEventTime(event)}</span>
                    {event.location && <span><MapPin size={13} aria-hidden="true" />{event.location}</span>}
                    {event.creator?.display_name && <small>{event.creator.display_name}</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>

      {editorOpen && (
        <div className={styles.editorOverlay} role="dialog" aria-modal="true" aria-label="予定編集">
          <form className={styles.editorPanel} onSubmit={saveEvent}>
            <div className={styles.editorHeader}>
              <h2>{editingEvent ? "予定を編集" : "予定を作成"}</h2>
              <button type="button" className={styles.iconButton} onClick={closeEditor} title="閉じる">
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            {error && <p className={styles.errorText}>{error}</p>}

            <label className={styles.field}>
              <span>タイトル</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                autoFocus
                maxLength={120}
              />
            </label>

            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>日付</span>
                <input
                  type="date"
                  value={form.date}
                  onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                />
              </label>
              <label className={styles.switchField}>
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(event) => setForm((current) => ({ ...current, allDay: event.target.checked }))}
                />
                <span>終日</span>
              </label>
            </div>

            {!form.allDay && (
              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span>開始</span>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))}
                  />
                </label>
                <label className={styles.field}>
                  <span>終了</span>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={(event) => setForm((current) => ({ ...current, endTime: event.target.value }))}
                  />
                </label>
              </div>
            )}

            <label className={styles.field}>
              <span>場所</span>
              <input
                value={form.location}
                onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))}
                maxLength={240}
              />
            </label>

            <div className={styles.colorPicker} aria-label="予定色">
              {EVENT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={form.color === color ? styles.colorSwatchActive : styles.colorSwatch}
                  style={{ background: color }}
                  onClick={() => setForm((current) => ({ ...current, color }))}
                  title={color}
                />
              ))}
            </div>

            <label className={styles.field}>
              <span>メモ</span>
              <textarea
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                rows={4}
                maxLength={2000}
              />
            </label>

            <div className={styles.editorActions}>
              {editingEvent && (
                <button type="button" className={styles.deleteButton} onClick={deleteEvent} disabled={saving}>
                  <Trash2 size={17} aria-hidden="true" />
                  削除
                </button>
              )}
              <button type="button" className={styles.cancelButton} onClick={closeEditor} disabled={saving}>
                キャンセル
              </button>
              <button type="submit" className={styles.saveButton} disabled={saving || !form.title.trim()}>
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
