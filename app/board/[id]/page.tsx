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

function getDriveFileId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "drive.google.com") {
      const id = parsed.searchParams.get("id");
      if (id) return id;

      const filePathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
      if (filePathMatch?.[1]) return filePathMatch[1];
    }
  } catch {
    return null;
  }

  return null;
}

function getAttachmentImageUrl(url: string) {
  const driveId = getDriveFileId(url);
  if (!driveId) return url;

  return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1200`;
}

export default function BoardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [groupName, setGroupName] = useState("掲示板");
  const [posts, setPosts] = useState<Post[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (!text.trim() && !selectedFile) return;

    let attachments = [];
    
    if (selectedFile) {
      setIsUploading(true);
      const formData = new FormData();
      formData.append('file', selectedFile);

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        
        if (res.ok) {
          const data = await res.json();
          attachments.push({
            type: data.type,
            url: data.viewUrl || data.url, // プレビュー用URLを優先
            name: data.name
          });
        } else {
          const data = await res.json().catch(() => null);
          alert(data?.error || 'ファイルのアップロードに失敗しました');
          setIsUploading(false);
          return;
        }
      } catch (err) {
        console.error(err);
        alert('ファイルのアップロードでエラーが発生しました');
        setIsUploading(false);
        return;
      }
    }

    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: id, content: text.trim(), attachments }),
    });

    if (res.ok) {
      setText("");
      setSelectedFile(null);
      setIsUploading(false);
      if (textareaRef.current) textareaRef.current.style.height = "38px";
      loadPosts();
    } else {
      setIsUploading(false);
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
                <div style={{ padding: "10px 14px" }}>
                  {post.attachments.map((att, i) =>
                    att.type?.startsWith("image") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={getAttachmentImageUrl(att.url)} alt={att.name} className="post-card__image" />
                    ) : (
                      <a
                        key={i}
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "block",
                          padding: "10px 14px",
                          background: "rgba(59, 130, 246, 0.1)",
                          border: "1px solid rgba(59, 130, 246, 0.2)",
                          borderRadius: 8,
                          marginBottom: 8,
                          color: "var(--accent)",
                          fontSize: 14,
                          fontWeight: 500,
                          textDecoration: "none"
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
      <div className="post-input-bar" style={{ flexDirection: "column", alignItems: "stretch", padding: 0 }}>
        {/* Selected file preview */}
        {selectedFile && (
          <div style={{ 
            padding: "8px 12px", 
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 12,
            color: "var(--text)"
          }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              📎 {selectedFile.name}
            </span>
            <button 
              type="button" 
              onClick={() => setSelectedFile(null)}
              style={{ color: "var(--text-sub)", fontSize: 16, padding: "0 4px" }}
            >
              ×
            </button>
          </div>
        )}
        
        <form
          style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "10px 12px" }}
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
            disabled={isUploading}
            style={{
              flex: 1,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 12px",
              color: "var(--text)",
              resize: "none",
              maxHeight: 120,
              minHeight: 38,
              outline: "none",
              lineHeight: 1.4,
              fontFamily: "inherit",
              fontSize: "inherit",
            }}
          />
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={(e) => e.target.files && setSelectedFile(e.target.files[0])}
            style={{ display: "none" }} 
            disabled={isUploading}
          />
          <button 
            type="button" 
            className="icon-btn" 
            aria-label="ファイルを添付"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            📎
          </button>
          <button
            type="submit"
            className="send-btn"
            aria-label="投稿を送信"
            disabled={(!text.trim() && !selectedFile) || isUploading}
          >
            {isUploading ? "..." : "↑"}
          </button>
        </form>
      </div>
    </>
  );
}
