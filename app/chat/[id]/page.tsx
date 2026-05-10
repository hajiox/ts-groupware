"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ChatUser = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role?: string;
  group_role?: string;
};

type Attachment = {
  url: string;
  viewUrl?: string;
  name: string;
  type: string;
  driveId?: string;
  webViewLink?: string;
};

type Message = {
  id: string;
  user_id: string;
  content: string | null;
  attachments: Attachment[];
  created_at: string;
  author: ChatUser;
  isOwn: boolean;
};

type ChatGroup = {
  id: string;
  name: string;
  icon: string;
};

function Avatar({ user, size = 30 }: { user: ChatUser; size?: number }) {
  if (user.picture_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.picture_url} alt="" title={user.display_name} className="avatar" width={size} height={size} />;
  }

  return (
    <div
      className="avatar-placeholder"
      title={user.display_name}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {user.display_name?.charAt(0) || "?"}
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function attachmentViewUrl(attachment: Attachment) {
  return attachment.viewUrl || attachment.url;
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageIdsRef = useRef<Set<string>>(new Set());

  const [group, setGroup] = useState<ChatGroup | null>(null);
  const [members, setMembers] = useState<ChatUser[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [notifMuted, setNotifMuted] = useState(false);
  const [notifToggling, setNotifToggling] = useState(false);

  const latestMessageAt = useMemo(() => {
    return messages.length > 0 ? messages[messages.length - 1].created_at : "";
  }, [messages]);

  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;

    setMessages(prev => {
      const next = [...prev];
      for (const message of incoming) {
        if (messageIdsRef.current.has(message.id)) continue;
        messageIdsRef.current.add(message.id);
        next.push(message);
      }
      return next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
  }, []);

  const loadChat = useCallback(async (since?: string) => {
    const params = new URLSearchParams({ group_id: id });
    if (since) params.set("since", since);

    const res = await fetch(`/api/chat?${params.toString()}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "チャットの取得に失敗しました");
    }

    setGroup(data.group);
    setMembers(data.members || []);

    if (since) {
      mergeMessages(data.messages || []);
    } else {
      messageIdsRef.current = new Set((data.messages || []).map((message: Message) => message.id));
      setMessages(data.messages || []);
    }
  }, [id, mergeMessages]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");

    loadChat()
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : "チャットの取得に失敗しました");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    fetch(`/api/notifications/settings?group_id=${id}`)
      .then((res) => (res.ok ? res.json() : { muted: false }))
      .then((data) => setNotifMuted(!!data.muted))
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [loadChat, id]);

  useEffect(() => {
    if (!latestMessageAt) return;

    const timer = window.setInterval(() => {
      loadChat(latestMessageAt).catch(err => {
        console.error("[Chat polling error]", err);
      });
    }, 4000);

    return () => window.clearInterval(timer);
  }, [latestMessageAt, loadChat]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: loading ? "auto" : "smooth" });
  }, [messages, loading]);

  async function uploadSelectedFile() {
    if (!selectedFile) return [];

    const formData = new FormData();
    formData.append("file", selectedFile);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "ファイルのアップロードに失敗しました");
    }

    return [{
      url: data.viewUrl || data.url,
      viewUrl: data.viewUrl,
      name: data.name || selectedFile.name,
      type: data.type || selectedFile.type,
      driveId: data.driveId,
      webViewLink: data.webViewLink,
    }];
  }

  async function handleSend() {
    const content = input.trim();
    if ((!content && !selectedFile) || sending) return;

    setSending(true);
    setError("");

    try {
      const attachments = await uploadSelectedFile();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: id, content, attachments }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "メッセージ送信に失敗しました");
      }

      mergeMessages([data.message]);
      setInput("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "メッセージ送信に失敗しました");
    } finally {
      setSending(false);
    }
  }

  async function toggleNotifMute() {
    const next = !notifMuted;
    setNotifToggling(true);
    try {
      const res = await fetch("/api/notifications/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: id, muted: next }),
      });
      if (res.ok) {
        setNotifMuted(next);
      }
    } catch (e) {
      console.error("通知設定の変更に失敗", e);
    } finally {
      setNotifToggling(false);
    }
  }

  async function deleteMessage(messageId: string) {
    if (!confirm("メッセージを削除しますか？")) return;

    try {
      const res = await fetch(`/api/posts?post_id=${messageId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "メッセージの削除に失敗しました");
      }

      setMessages(prev => prev.filter(m => m.id !== messageId));
      messageIdsRef.current.delete(messageId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "メッセージの削除に失敗しました");
    }
  }

  return (
    <>
      <header className="top-header" role="banner">
        <button
          type="button"
          className="top-header__back"
          onClick={() => router.push("/groups")}
          aria-label="グループ一覧に戻る"
        >
          ‹
        </button>
        <h1 className="top-header__title">
          <span aria-hidden="true">{group?.icon || "💬"}</span>
          {group?.name || "チャット"}
        </h1>
        <button
          type="button"
          className={`notif-toggle-btn${notifMuted ? " notif-toggle-btn--muted" : ""}`}
          onClick={toggleNotifMute}
          disabled={notifToggling}
          aria-label={notifMuted ? "通知をONにする" : "通知をOFFにする"}
          title={notifMuted ? "通知OFF中 — タップでON" : "通知ON中 — タップでOFF"}
        >
          {notifMuted ? "🔕" : "🔔"}
        </button>
      </header>

      <section className="chat-messages" aria-label="チャットメッセージ" role="log" aria-live="polite">
        {loading && <p className="chat-empty">読み込み中...</p>}

        {!loading && error && messages.length === 0 && (
          <div className="chat-error">
            <p>{error}</p>
            <button type="button" className="btn-primary" onClick={() => router.push("/groups")}>
              グループ一覧へ戻る
            </button>
          </div>
        )}

        {!loading && !error && messages.length === 0 && (
          <p className="chat-empty">メッセージはまだありません。最初のメッセージを送りましょう。</p>
        )}

        {messages.map(message => (
          <div key={message.id} className={`msg msg--${message.isOwn ? "own" : "other"}`}>
            <div className="msg__avatar-col">
              <Avatar user={message.author} />
            </div>

            <div className="msg__body">
              {!message.isOwn && <span className="msg__name">{message.author.display_name}</span>}

              {message.content && <div className="msg__bubble">{message.content}</div>}

              {message.attachments?.map((attachment, index) => {
                const viewUrl = attachmentViewUrl(attachment);
                if (attachment.type?.startsWith("image/")) {
                  return (
                    <button
                      key={`${message.id}-${index}`}
                      type="button"
                      className="msg__image-btn"
                      onClick={() => setPreviewImage(viewUrl)}
                      aria-label={`${attachment.name}を拡大表示`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={viewUrl} alt={attachment.name} className="msg__image" />
                    </button>
                  );
                }

                return (
                  <a
                    key={`${message.id}-${index}`}
                    href={attachment.webViewLink || attachment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="msg__file"
                  >
                    <span aria-hidden="true">📎</span>
                    <span>{attachment.name}</span>
                  </a>
                );
              })}
            </div>

            <div className="msg__meta">
              {message.isOwn && (
                <button
                  type="button"
                  className="msg__delete-btn"
                  onClick={() => deleteMessage(message.id)}
                  aria-label="メッセージを削除"
                  title="メッセージを削除"
                >
                  削除
                </button>
              )}
              <time className="msg__time" dateTime={message.created_at}>
                {formatTime(message.created_at)}
              </time>
            </div>
          </div>
        ))}

        <div ref={bottomRef} aria-hidden="true" />
      </section>

      {error && messages.length > 0 && <div className="chat-inline-error">{error}</div>}

      <form
        className="chat-input-bar"
        onSubmit={(e) => {
          e.preventDefault();
        }}
        aria-label="メッセージ入力"
      >
        {selectedFile && (
          <div className="chat-selected-file">
            <span>{selectedFile.name}</span>
            <button
              type="button"
              onClick={() => {
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              aria-label="添付を解除"
            >
              ×
            </button>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          className="visually-hidden"
          onChange={e => setSelectedFile(e.target.files?.[0] || null)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="ファイルを添付"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
        >
          📎
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="メッセージを入力..."
          aria-label="メッセージ"
          autoComplete="off"
          disabled={sending}
        />
        <button
          type="button"
          className="send-btn"
          aria-label="送信"
          disabled={sending || (!input.trim() && !selectedFile)}
          onClick={handleSend}
        >
          {sending ? "…" : "↑"}
        </button>
      </form>

      {previewImage && (
        <div className="image-preview" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}>
          <button type="button" className="image-preview__close" onClick={() => setPreviewImage(null)} aria-label="閉じる">
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewImage} alt="添付画像プレビュー" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}
