"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type TaskUser = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type TaskItem = {
  id: string;
  post_id: string;
  group_id: string;
  requester_id: string;
  assignee_id: string;
  due_date: string;
  completed_at: string | null;
  created_at: string;
  post: { id: string; content: string | null; created_at: string } | null;
  group: { id: string; name: string; type: "board" | "chat" } | null;
  requester: TaskUser | null;
  assignee: TaskUser | null;
  completedBy: TaskUser | null;
};

function formatDueDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
}

function isOverdue(value: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${value}T00:00:00`);
  return due.getTime() < today.getTime();
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);

  function loadTasks() {
    setLoading(true);
    fetch("/api/tasks?status=all", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { tasks: [] }))
      .then((data) => setTasks(data.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadTasks();
  }, []);

  const openTasks = useMemo(() => tasks.filter(task => !task.completed_at), [tasks]);
  const completedTasks = useMemo(() => tasks.filter(task => task.completed_at), [tasks]);

  async function completeTask(taskId: string) {
    setCompletingId(taskId);
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "タスクの完了に失敗しました");
      if (data?.task) {
        setTasks((current) => current.map(task => task.id === taskId ? data.task : task));
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "タスクの完了に失敗しました");
    } finally {
      setCompletingId(null);
    }
  }

  function renderTask(task: TaskItem) {
    const done = Boolean(task.completed_at);
    const overdue = !done && isOverdue(task.due_date);
    const boardHref = task.group ? `/board/${task.group_id}#post-${task.post_id}` : "/groups";

    return (
      <article key={task.id} className={`task-card${done ? " task-card--done" : ""}`}>
        <div className="task-card__main">
          <div className="task-card__header">
            <span className={`task-card__status${overdue ? " task-card__status--overdue" : ""}`}>
              {done ? "完了" : overdue ? "期限超過" : "未完了"}
            </span>
            <span className="task-card__due">期限 {formatDueDate(task.due_date)}</span>
          </div>
          <p className="task-card__content">{task.post?.content || "（本文なし）"}</p>
          <div className="task-card__meta">
            <span>{task.group?.name || "掲示板"}</span>
            <span>依頼者: {task.requester?.display_name || "不明"}</span>
          </div>
        </div>
        <div className="task-card__actions">
          <Link href={boardHref} className="task-card__link">投稿を見る</Link>
          {!done && (
            <button
              type="button"
              className="task-card__complete"
              onClick={() => completeTask(task.id)}
              disabled={completingId === task.id}
            >
              {completingId === task.id ? "完了中..." : "完了"}
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <>
      <header className="top-header" role="banner">
        <Link href="/groups" className="top-header__back" aria-label="ホームに戻る">‹</Link>
        <h1 className="top-header__title">タスク一覧</h1>
      </header>

      <main className="tasks-page page-content">
        {loading ? (
          <p className="post-list__state">読み込み中...</p>
        ) : (
          <>
            <section className="tasks-section">
              <div className="tasks-section__header">
                <h2>未完了のタスク</h2>
                <span>{openTasks.length}件</span>
              </div>
              {openTasks.length > 0 ? openTasks.map(renderTask) : (
                <p className="tasks-empty">未完了のタスクはありません。</p>
              )}
            </section>

            <section className="tasks-section">
              <div className="tasks-section__header">
                <h2>完了済み</h2>
                <span>{completedTasks.length}件</span>
              </div>
              {completedTasks.length > 0 ? completedTasks.map(renderTask) : (
                <p className="tasks-empty">完了済みタスクはまだありません。</p>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
