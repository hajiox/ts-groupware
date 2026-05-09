"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;
const IMAGE_UPLOAD_MAX_SIZE = 1600;
const IMAGE_UPLOAD_QUALITY = 0.82;

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
  attachments: { type: string; url: string; name: string; driveId?: string; webViewLink?: string }[];
  created_at: string;
  is_pinned: boolean;
  author: Author;
  reactions: Record<string, { count: number; hasOwn: boolean }>;
  commentCount: number;
};

type CurrentUser = {
  id: string;
  role: string;
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

function getCompressedImageName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, "");
  return `${baseName || "image"}.jpg`;
}

async function loadImageSource(file: File) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = objectUrl;
  });

  return {
    source: image,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    close: () => URL.revokeObjectURL(objectUrl),
  };
}

async function prepareUploadFile(file: File, uploadOriginal: boolean) {
  if (uploadOriginal || !file.type.startsWith("image/")) return file;

  const image = await loadImageSource(file);
  try {
    const scale = Math.min(1, IMAGE_UPLOAD_MAX_SIZE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    ctx.drawImage(image.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", IMAGE_UPLOAD_QUALITY);
    });
    if (!blob) return file;

    if (scale === 1 && blob.size >= file.size) return file;

    return new File([blob], getCompressedImageName(file.name), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } finally {
    image.close();
  }
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
  const [uploadOriginal, setUploadOriginal] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
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

    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.user) {
          setCurrentUser({ id: data.user.id, role: data.user.role });
        }
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

      try {
        const uploadFile = await prepareUploadFile(selectedFile, uploadOriginal);
        formData.append('file', uploadFile);
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        
        if (res.ok) {
          const data = await res.json();
          attachments.push({
            type: data.type,
            url: data.viewUrl || data.url, // プレビュー用URLを優先
            name: data.name,
            driveId: data.driveId,
            webViewLink: data.webViewLink,
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
      const data = await res.json().catch(() => null);
      setText("");
      setSelectedFile(null);
      setUploadOriginal(false);
      setIsUploading(false);
      if (textareaRef.current) textareaRef.current.style.height = "38px";
      if (data?.post) {
        setPosts(current => [data.post, ...current]);
      } else {
        loadPosts();
      }
    } else {
      setIsUploading(false);
    }
  }

  async function handleReaction(postId: string, emoji: string) {
    setPosts(current => current.map(post => {
      if (post.id !== postId) return post;
      const currentReaction = post.reactions[emoji] || { count: 0, hasOwn: false };
      const nextCount = currentReaction.hasOwn
        ? Math.max(0, currentReaction.count - 1)
        : currentReaction.count + 1;

      return {
        ...post,
        reactions: {
          ...post.reactions,
          [emoji]: {
            count: nextCount,
            hasOwn: !currentReaction.hasOwn,
          },
        },
      };
    }));

    const res = await fetch("/api/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId, emoji }),
    });

    if (!res.ok) loadPosts();
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setUploadOriginal(false);
  }

  function canEditPost(post: Post) {
    return currentUser?.id === post.user_id;
  }

  function canDeletePost(post: Post) {
    return currentUser?.id === post.user_id || currentUser?.role === "admin";
  }

  function startEditing(post: Post) {
    setEditingPostId(post.id);
    setEditingText(post.content || "");
  }

  async function saveEdit(post: Post) {
    const res = await fetch("/api/posts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: post.id, content: editingText }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || "投稿の更新に失敗しました");
      return;
    }

    const data = await res.json();
    setPosts(current => current.map(item => (
      item.id === post.id ? { ...item, content: data.post.content } : item
    )));
    setEditingPostId(null);
    setEditingText("");
  }

  async function deletePost(post: Post) {
    if (!confirm("この投稿を削除しますか？")) return;

    const res = await fetch(`/api/posts?post_id=${post.id}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      alert(data?.error || "投稿の削除に失敗しました");
      return;
    }

    const data = await res.json().catch(() => null);
    const deletedIds = new Set<string>(data?.deletedIds || [post.id]);
    setPosts(current => current.filter(item => !deletedIds.has(item.id)));
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
                {(canEditPost(post) || canDeletePost(post)) && (
                  <div className="post-card__actions" aria-label="投稿操作">
                    {canEditPost(post) && (
                      <button
                        type="button"
                        className="post-card__action-btn"
                        onClick={() => startEditing(post)}
                      >
                        編集
                      </button>
                    )}
                    {canDeletePost(post) && (
                      <button
                        type="button"
                        className="post-card__action-btn post-card__action-btn--danger"
                        onClick={() => deletePost(post)}
                      >
                        削除
                      </button>
                    )}
                  </div>
                )}
              </header>

              {/* Body */}
              {editingPostId === post.id ? (
                <div className="post-card__edit">
                  <textarea
                    className="post-card__edit-textarea"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    rows={3}
                    aria-label="投稿編集"
                  />
                  <div className="post-card__edit-actions">
                    <button
                      type="button"
                      className="post-card__edit-btn"
                      onClick={() => saveEdit(post)}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="post-card__edit-btn post-card__edit-btn--sub"
                      onClick={() => {
                        setEditingPostId(null);
                        setEditingText("");
                      }}
                    >
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : post.content && (
                <div className="post-card__body" style={{ whiteSpace: "pre-wrap" }}>
                  {post.content}
                </div>
              )}

              {/* Attachments */}
              {post.attachments?.length > 0 && (
                <div style={{ padding: "10px 14px" }}>
                  {post.attachments.map((att, i) => {
                    if (att.type?.startsWith("image")) {
                      const imageUrl = getAttachmentImageUrl(att.url);

                      return (
                        <button
                          key={i}
                          type="button"
                          className="post-card__image-button"
                          onClick={() => setPreviewImage({ url: imageUrl, name: att.name })}
                          aria-label={`${att.name}を拡大表示`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imageUrl} alt={att.name} className="post-card__image" />
                        </button>
                      );
                    }

                    return (
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
                    );
                  })}
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
          <div className="selected-file">
            <div className="selected-file__main">
              <span className="selected-file__name">
                📎 {selectedFile.name}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setUploadOriginal(false);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="selected-file__remove"
                aria-label="添付ファイルを削除"
              >
                ×
              </button>
            </div>
            {selectedFile.type.startsWith("image/") && (
              <div className="selected-file__mode">
                <span>{uploadOriginal ? "元画像のままアップロード" : "縮小してアップロード"}</span>
                <button
                  type="button"
                  className="selected-file__mode-btn"
                  onClick={() => setUploadOriginal(current => !current)}
                >
                  {uploadOriginal ? "縮小に戻す" : "元画像で送る"}
                </button>
              </div>
            )}
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
            onChange={handleFileChange}
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

      {previewImage && (
        <div
          className="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={previewImage.name}
          onClick={() => setPreviewImage(null)}
        >
          <button
            type="button"
            className="image-preview-close"
            onClick={() => setPreviewImage(null)}
            aria-label="拡大表示を閉じる"
          >
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewImage.url}
            alt={previewImage.name}
            className="image-preview-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
