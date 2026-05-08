"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useRef } from "react";
import { MOCK_GROUPS, MOCK_POSTS } from "@/lib/mock-data";

const REACTIONS = ["👍", "❤️", "😮"] as const;
type ReactionKey = (typeof REACTIONS)[number];

function AvatarPlaceholder({
  initials,
  color,
  size = 38,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const group = MOCK_GROUPS.find((g) => g.id === id);
  const initialPosts = MOCK_POSTS.filter((p) => p.groupId === id);

  const [posts, setPosts] = useState(initialPosts);
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>(
    Object.fromEntries(initialPosts.map((p) => [p.id, { ...p.reactions }]))
  );
  const [activeReactions, setActiveReactions] = useState<Record<string, ReactionKey | null>>(
    Object.fromEntries(initialPosts.map((p) => [p.id, null]))
  );
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleReaction(postId: string, emoji: ReactionKey) {
    setReactions((prev) => {
      const updated = { ...prev[postId] };
      const current = activeReactions[postId];
      if (current === emoji) {
        updated[emoji] = Math.max(0, (updated[emoji] ?? 0) - 1);
        setActiveReactions((a) => ({ ...a, [postId]: null }));
      } else {
        if (current) updated[current] = Math.max(0, (updated[current] ?? 0) - 1);
        updated[emoji] = (updated[emoji] ?? 0) + 1;
        setActiveReactions((a) => ({ ...a, [postId]: emoji }));
      }
      return { ...prev, [postId]: updated };
    });
  }

  function handlePost() {
    if (!text.trim()) return;
    const newPost = {
      id: `p-new-${Date.now()}`,
      groupId: id,
      author: { id: "u1", name: "田中 太郎", initials: "田", color: "#3b82f6" },
      createdAt: new Date().toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
      body: text.trim(),
      imageUrl: null,
      reactions: { "👍": 0, "❤️": 0, "😮": 0 },
      commentCount: 0,
    };
    setPosts((prev) => [newPost, ...prev]);
    setReactions((prev) => ({ ...prev, [newPost.id]: { "👍": 0, "❤️": 0, "😮": 0 } }));
    setActiveReactions((prev) => ({ ...prev, [newPost.id]: null }));
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "38px";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handlePost();
    }
  }

  function autoResize(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "38px";
    el.style.height = `${el.scrollHeight}px`;
  }

  return (
    <>
      {/* Header */}
      <header className="top-header" role="banner">
        <button
          type="button"
          className="top-header__back"
          onClick={() => router.push("/groups")}
          aria-label="グループ一覧に戻る"
        >
          ‹
        </button>
        <h1 className="top-header__title">{group?.name ?? "掲示板"}</h1>
        <span className="top-header__meta">掲示板</span>
      </header>

      {/* Posts */}
      <section className="post-list" aria-label="投稿一覧">
        {posts.length === 0 && (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            投稿がありません。最初の投稿をしてみましょう！
          </p>
        )}
        {posts.map((post) => (
          <article key={post.id} className="post-card">
            {/* Post header */}
            <header className="post-card__header">
              <AvatarPlaceholder
                initials={post.author.initials}
                color={post.author.color}
                size={40}
              />
              <div className="post-card__user-info">
                <div className="post-card__username">{post.author.name}</div>
                <div className="post-card__time">{post.createdAt}</div>
              </div>
            </header>

            {/* Body */}
            <div className="post-card__body" style={{ whiteSpace: "pre-wrap" }}>
              {post.body}
            </div>

            {/* Image thumbnail */}
            {post.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.imageUrl}
                alt="投稿画像"
                className="post-card__image"
              />
            )}

            {/* Reactions */}
            <div className="post-card__reactions" role="group" aria-label="リアクション">
              {REACTIONS.map((emoji) => {
                const count = reactions[post.id]?.[emoji] ?? 0;
                const isActive = activeReactions[post.id] === emoji;
                return (
                  <button
                    key={emoji}
                    type="button"
                    className={`reaction-btn${isActive ? " reaction-btn--active" : ""}`}
                    onClick={() => handleReaction(post.id, emoji)}
                    aria-label={`${emoji} ${count}件${isActive ? "（選択中）" : ""}`}
                    aria-pressed={isActive}
                  >
                    <span aria-hidden="true">{emoji}</span>
                    {count > 0 && <span>{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* Footer */}
            <footer className="post-card__footer">
              <button type="button" className="post-card__footer-btn">
                💬 {post.commentCount}件のコメント
              </button>
              <button type="button" className="post-card__footer-btn">
                コメントする
              </button>
            </footer>
          </article>
        ))}
      </section>

      {/* Post input bar */}
      <form
        className="post-input-bar"
        onSubmit={(e) => { e.preventDefault(); handlePost(); }}
        aria-label="新規投稿"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={autoResize}
          onKeyDown={handleKeyDown}
          placeholder="投稿内容を入力… (Ctrl+Enter で送信)"
          rows={1}
          aria-label="投稿テキスト"
        />
        <button type="button" className="icon-btn" aria-label="画像を添付">
          📎
        </button>
        <button
          type="submit"
          className="send-btn"
          aria-label="投稿を送信"
          disabled={!text.trim()}
        >
          ↑
        </button>
      </form>
    </>
  );
}
