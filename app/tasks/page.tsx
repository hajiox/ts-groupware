"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const TASK_PREVIEW_LIMIT = 10;
const MENTION_PREVIEW_LIMIT = 10;

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

type MentionItem = {
  id: string;
  sender_id: string | null;
  sender_name: string;
  group_id: string | null;
  group_name: string | null;
  post_id: string;
  context_type: "board" | "chat" | "dm";
  context_label: string;
  content_snippet: string;
  url: string;
  created_at: string;
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

function formatMentionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [showAllMentions, setShowAllMentions] = useState(false);

  function loadTasks() {
    setLoading(true);
    fetch("/api/tasks?status=all", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { tasks: [], mentions: [] }))
      .then((data) => {
        setTasks(data.tasks || []);
        setMentions(data.mentions || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadTasks();
  }, []);

  const openTasks = useMemo(() => tasks.filter(task => !task.completed_at), [tasks]);
  const taskRequests = useMemo(() => {
    return [...tasks].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [tasks]);
  const visibleTaskRequests = useMemo(
    () => showAllTasks ? taskRequests : taskRequests.slice(0, TASK_PREVIEW_LIMIT),
    [showAllTasks, taskRequests],
  );
  const visibleMentions = useMemo(
    () => showAllMentions ? mentions : mentions.slice(0, MENTION_PREVIEW_LIMIT),
    [mentions, showAllMentions],
  );

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

  function renderMention(mention: MentionItem) {
    const location = mention.group_name
      ? `${mention.context_label}「${mention.group_name}」`
      : mention.context_label;

    return (
      <Link key={mention.id} href={mention.url || "/groups"} className="mention-history-card">
        <div className="mention-history-card__main">
          <div className="mention-history-card__header">
            <span className="mention-history-card__location">{location}</span>
            <span className="mention-history-card__time">{formatMentionDate(mention.created_at)}</span>
          </div>
          <p className="mention-history-card__content">{mention.content_snippet || "（本文なし）"}</p>
          <div className="mention-history-card__meta">
            <span>送信者: {mention.sender_name || "不明"}</span>
          </div>
        </div>
        <span className="mention-history-card__open">開く</span>
      </Link>
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
                <h2>タスク依頼</h2>
                <span>未完了 {openTasks.length}件 / 全{taskRequests.length}件</span>
              </div>
              {visibleTaskRequests.length > 0 ? visibleTaskRequests.map(renderTask) : (
                <p className="tasks-empty">タスク依頼はありません。</p>
              )}
              {taskRequests.length > TASK_PREVIEW_LIMIT && (
                <button
                  type="button"
                  className="tasks-section__more"
                  onClick={() => setShowAllTasks((current) => !current)}
                >
                  {showAllTasks ? "最新10件に戻す" : `過去のタスク依頼を見る（残り${taskRequests.length - TASK_PREVIEW_LIMIT}件）`}
                </button>
              )}
            </section>

            <section className="tasks-section">
              <div className="tasks-section__header">
                <h2>自分へのメンション</h2>
                <span>{mentions.length}件 / 最新10件表示</span>
              </div>
              {visibleMentions.length > 0 ? visibleMentions.map(renderMention) : (
                <p className="tasks-empty">メンションされた投稿はありません。</p>
              )}
              {mentions.length > MENTION_PREVIEW_LIMIT && (
                <button
                  type="button"
                  className="tasks-section__more"
                  onClick={() => setShowAllMentions((current) => !current)}
                >
                  {showAllMentions ? "最新10件に戻す" : `過去のメンションを見る（残り${mentions.length - MENTION_PREVIEW_LIMIT}件）`}
                </button>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
