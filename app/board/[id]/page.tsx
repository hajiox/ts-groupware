"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;

type Author = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type Post = {
  id: string;
  group_id: string;
  user_id: string;
  content: string | null;
  attachments: { type: string; url: string; name: string }[];
  created_at: string;
  is_pinned: boolean;
  author: Author;
  reactions: Record<string, { count: number; hasOwn: boolean }>;
  commentCount: number;
};

function Avatar({ user, size = 38 }: { user: Author; size?: number }) {
  if (user.picture_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.picture_url}
        alt={user.display_name}
        className="avatar"
        width={size}
        height={size}
      />
    );
  }
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, background: "#3b82f6", fontSize: size * 0.4 }}
    >
      {user.display_name?.charAt(0) || "?"}
    </div>
  );
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "たった今";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`;
  return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [groupName, setGroupName] = useState("掲示板");
  const [posts, setPosts] = useState<Post[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // グループ名取得
    fetch("/api/groups")
      .then(r => r.ok ? r.json() : { groups: [] })
      .then(data => {
        const g = data.groups?.find((g: { id: string; name: string }) => g.id === id);
        if (g) setGroupName(g.name);
      })
      .catch(() => {});

    loadPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function loadPosts() {
    fetch(`/api/posts?group_id=${id}`)
      .then(r => r.ok ? r.json() : { posts: [] })
      .then(data => setPosts(data.posts))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function handlePost() {
    if (!text.trim()) return;

    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: id, content: text.trim() }),
    });

    if (res.ok) {
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "38px";
      loadPosts();
    }
  }

  async function handleReaction(postId: string, emoji: string) {
    await fetch("/api/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId, emoji }),
    });
    loadPosts();
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
        <h1 className="top-header__title">{groupName}</h1>
        <span className="top-header__meta">掲示板</span>
      </header>

      {/* Posts */}
      <section className="post-list" aria-label="投稿一覧">
        {loading ? (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            読み込み中...
          </p>
        ) : posts.length === 0 ? (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            投稿がありません。最初の投稿をしてみましょう！
          </p>
        ) : (
          posts.map((post) => (
            <article key={post.id} className="post-card">
              {/* Pinned badge */}
              {post.is_pinned && (
                <div style={{ padding: "6px 14px 0", fontSize: 11, color: "var(--accent)" }}>
                  📌 ピン留め
                </div>
              )}

              {/* Post header */}
              <header className="post-card__header">
                <Avatar user={post.author} size={40} />
                <div className="post-card__user-info">
                  <div className="post-card__username">{post.author.display_name}</div>
                  <div className="post-card__time">{formatDate(post.created_at)}</div>
                </div>
              </header>

              {/* Body */}
              {post.content && (
                <div className="post-card__body" style={{ whiteSpace: "pre-wrap" }}>
                  {post.content}
                </div>
              )}

              {/* Attachments */}
              {post.attachments?.length > 0 && (
                <div style={{ padding: "0 14px" }}>
                  {post.attachments.map((att, i) =>
                    att.type?.startsWith("image") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={att.url} alt={att.name} className="post-card__image" />
                    ) : (
                      <a
                        key={i}
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "block",
                          padding: "8px 12px",
                          background: "var(--bg)",
                          borderRadius: 8,
                          marginBottom: 8,
                          color: "var(--accent)",
                          fontSize: 13,
                        }}
                      >
                        📎 {att.name}
                      </a>
                    )
                  )}
                </div>
              )}

              {/* Reactions */}
              <div className="post-card__reactions" role="group" aria-label="リアクション">
                {REACTION_EMOJIS.map((emoji) => {
                  const data = post.reactions[emoji];
                  const count = data?.count || 0;
                  const isActive = data?.hasOwn || false;
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className={`reaction-btn${isActive ? " reaction-btn--active" : ""}`}
                      onClick={() => handleReaction(post.id, emoji)}
                      aria-label={`${emoji} ${count}件`}
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
          ))
        )}
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
