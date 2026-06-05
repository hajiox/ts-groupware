"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClipboardImageFile } from "@/lib/clipboard-image";
import { getDeviceHeaders } from "@/lib/device-id";

const REACTION_EMOJIS = ["👍", "❤️", "😮", "🙌", "🙏", "👀"] as const;

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
  updated_at?: string;
  author: ChatUser;
  isOwn: boolean;
  reactions: Record<string, { count: number; hasOwn: boolean }>;
};

type ChatGroup = {
  id: string;
  name: string;
  icon: string;
  description?: string | null;
};

type ReadReceipt = {
  user_id: string;
  last_read_at: string;
};

type CurrentUser = {
  id: string;
  role?: string;
  group_role?: string;
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

function formatMentionName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return /(さん|様|さま|君|くん|ちゃん)$/.test(trimmed) ? trimmed : `${trimmed}さん`;
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
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
  const [readReceipts, setReadReceipts] = useState<ReadReceipt[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const latestMessageAt = useMemo(() => {
    return messages.length > 0 ? messages[messages.length - 1].created_at : "";
  }, [messages]);

  const filteredMessages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return messages;

    return messages.filter((message) => {
      const target = [
        message.content || "",
        message.author?.display_name || "",
        ...(message.attachments || []).map((attachment) => attachment.name || ""),
      ].join(" ").toLowerCase();

      return target.includes(query);
    });
  }, [messages, searchQuery]);

  const mentionMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const aIsAdmin = a.role === "admin" || a.group_role === "admin";
      const bIsAdmin = b.role === "admin" || b.group_role === "admin";
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1;
      return a.display_name.localeCompare(b.display_name, "ja");
    });
  }, [members]);

  const isDirectChat = group?.description?.startsWith("direct:") || false;
  const canModerateChat = currentUser?.role === "admin" || currentUser?.group_role === "admin";

  const mergeMessages = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;

    setMessages(prev => {
      const next = [...prev];
      for (const message of incoming) {
        if (messageIdsRef.current.has(message.id)) {
          const index = next.findIndex(item => item.id === message.id);
          if (index >= 0) {
            next[index] = { ...next[index], ...message };
          }
          continue;
        }
        messageIdsRef.current.add(message.id);
        next.push(message);
      }
      return next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
  }, []);

  const loadChat = useCallback(async (since?: string) => {
    const params = new URLSearchParams({ group_id: id });
    if (since) params.set("since", since);

    const res = await fetch(`/api/chat?${params.toString()}`, {
      cache: "no-store",
      headers: getDeviceHeaders(),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "チャットの取得に失敗しました");
    }

    setGroup(data.group);
    setMembers(data.members || []);
    setCurrentUser(data.currentUser || null);
    if (data.readReceipts) setReadReceipts(data.readReceipts);

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
      setMentionPickerOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "メッセージ送信に失敗しました");
    } finally {
      setSending(false);
    }
  }

  function insertMention(member: ChatUser) {
    const inputElement = messageInputRef.current;
    const start = inputElement?.selectionStart ?? input.length;
    const end = inputElement?.selectionEnd ?? input.length;
    const needsLeadingSpace = start > 0 && !/\s/.test(input.charAt(start - 1));
    const mention = `${needsLeadingSpace ? " " : ""}@${formatMentionName(member.display_name)} `;
    const nextInput = `${input.slice(0, start)}${mention}${input.slice(end)}`;
    const cursor = start + mention.length;

    setInput(nextInput);
    setMentionPickerOpen(false);

    window.setTimeout(() => {
      if (!messageInputRef.current) return;
      messageInputRef.current.focus();
      messageInputRef.current.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function handleMessagePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;

    e.preventDefault();
    setSelectedFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
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

  function applyReaction(message: Message, emoji: string): Message {
    const currentReaction = message.reactions?.[emoji] || { count: 0, hasOwn: false };
    const nextCount = currentReaction.hasOwn
      ? Math.max(0, currentReaction.count - 1)
      : currentReaction.count + 1;

    return {
      ...message,
      reactions: {
        ...(message.reactions || {}),
        [emoji]: {
          count: nextCount,
          hasOwn: !currentReaction.hasOwn,
        },
      },
    };
  }

  async function handleReaction(messageId: string, emoji: string) {
    setMessages((current) => current.map((message) => (
      message.id === messageId ? applyReaction(message, emoji) : message
    )));

    const res = await fetch("/api/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: messageId, emoji }),
    });

    if (!res.ok) {
      loadChat().catch(err => {
        console.error("[Chat reaction reload error]", err);
      });
    }
  }

  function canEditMessage(message: Message) {
    return message.isOwn || canModerateChat;
  }

  function canDeleteMessage(message: Message) {
    return !isDirectChat && (message.isOwn || canModerateChat);
  }

  function startEditingMessage(message: Message) {
    setEditingMessageId(message.id);
    setEditingText(message.content || "");
  }

  function cancelEditingMessage() {
    setEditingMessageId(null);
    setEditingText("");
  }

  async function saveEditingMessage(message: Message) {
    const content = editingText.trim();
    if (savingEdit || (!content && (!message.attachments || message.attachments.length === 0))) return;

    setSavingEdit(true);
    setError("");
    try {
      const res = await fetch("/api/chat", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: message.id, content }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "メッセージの編集に失敗しました");
      }

      setMessages(prev => prev.map(item => (
        item.id === message.id
          ? { ...item, content: data.message?.content ?? null, updated_at: data.message?.updated_at || item.updated_at }
          : item
      )));
      cancelEditingMessage();
    } catch (e) {
      setError(e instanceof Error ? e.message : "メッセージの編集に失敗しました");
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteMessage(messageId: string) {
    if (!confirm("メッセージを削除しますか？")) return;

    try {
      const res = await fetch(`/api/chat?message_id=${messageId}`, {
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
        {!group?.description?.startsWith("direct:") && (
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
        )}
      </header>

      <div className="thread-search thread-search--chat" role="search">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Chatを検索"
          aria-label="Chatを検索"
        />
        {searchQuery && (
          <button type="button" onClick={() => setSearchQuery("")} aria-label="検索をクリア">
            クリア
          </button>
        )}
      </div>

      <section className="chat-messages" aria-label="チャットメッセージ" role="log" aria-live="polite">
        {group?.description?.startsWith("direct:") && (
          <div className="chat-privacy-banner">
            <span className="chat-privacy-banner__icon" aria-hidden="true">🔒</span>
            <span>このチャットは安全に保護されています。通信はすべて暗号化され、会話内容が第三者に共有されることはありません。</span>
          </div>
        )}

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

        {!loading && !error && messages.length > 0 && filteredMessages.length === 0 && (
          <p className="chat-empty">検索条件に一致するメッセージはありません。</p>
        )}

        {filteredMessages.map(message => {
          const isEditing = editingMessageId === message.id;
          const isEdited = Boolean(message.updated_at && new Date(message.updated_at).getTime() > new Date(message.created_at).getTime() + 1000);

          return (
          <div key={message.id} className={`msg msg--${message.isOwn ? "own" : "other"}`}>
            <div className="msg__avatar-col">
              <Avatar user={message.author} />
            </div>

            <div className="msg__body">
              {!message.isOwn && <span className="msg__name">{message.author.display_name}</span>}

              {isEditing ? (
                <form
                  className="msg-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveEditingMessage(message);
                  }}
                >
                  <textarea
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        saveEditingMessage(message);
                      }
                      if (event.key === "Escape") {
                        cancelEditingMessage();
                      }
                    }}
                    rows={3}
                    autoFocus
                    disabled={savingEdit}
                    aria-label="メッセージを編集"
                  />
                  <div className="msg-edit-form__actions">
                    <button type="button" onClick={cancelEditingMessage} disabled={savingEdit}>
                      キャンセル
                    </button>
                    <button
                      type="submit"
                      className="msg-edit-form__save"
                      disabled={savingEdit || (!editingText.trim() && (!message.attachments || message.attachments.length === 0))}
                    >
                      {savingEdit ? "保存中" : "保存"}
                    </button>
                  </div>
                </form>
              ) : (
                message.content && <div className="msg__bubble">{message.content}</div>
              )}

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

              <div className="msg__reactions" role="group" aria-label="リアクション">
                {REACTION_EMOJIS.map((emoji) => {
                  const data = message.reactions?.[emoji];
                  const count = data?.count || 0;
                  const isActive = data?.hasOwn || false;

                  return (
                    <button
                      key={emoji}
                      type="button"
                      className={`reaction-btn${isActive ? " reaction-btn--active" : ""}`}
                      onClick={() => handleReaction(message.id, emoji)}
                      aria-label={`${emoji} ${count}件`}
                      aria-pressed={isActive}
                    >
                      <span aria-hidden="true">{emoji}</span>
                      {count > 0 && <span>{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="msg__meta">
              {message.isOwn && (() => {
                const readCount = readReceipts.filter(
                  r => new Date(r.last_read_at) >= new Date(message.created_at)
                ).length;
                return readCount > 0 ? (
                  <span className="msg__read-receipt">既読{readCount > 1 ? ` ${readCount}` : ""}</span>
                ) : null;
              })()}
              {isEdited && <span className="msg__edited">{"\u7de8\u96c6\u6e08\u307f"}</span>}
              {canEditMessage(message) && !isEditing && (
                <button
                  type="button"
                  className="msg__action-btn"
                  onClick={() => startEditingMessage(message)}
                  aria-label="\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u7de8\u96c6"
                  title="\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u7de8\u96c6"
                >
                  {"\u7de8\u96c6"}
                </button>
              )}
              {canDeleteMessage(message) && (
                <button
                  type="button"
                  className="msg__action-btn msg__delete-btn"
                  onClick={() => deleteMessage(message.id)}
                  aria-label="\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u524a\u9664"
                  title="\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u524a\u9664"
                >
                  {"\u524a\u9664"}
                </button>
              )}
              <time className="msg__time" dateTime={message.created_at}>
                {formatTime(message.created_at)}
              </time>
            </div>
          </div>
          );
        })}

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

        {mentionPickerOpen && (
          <div className="mention-picker mention-picker--chat" role="listbox" aria-label="メンション候補">
            {mentionMembers.length === 0 ? (
              <span className="mention-picker__empty">メンションできるメンバーがいません</span>
            ) : (
              mentionMembers.map((member) => {
                const isAdmin = member.role === "admin" || member.group_role === "admin";
                return (
                  <button
                    key={member.id}
                    type="button"
                    className="mention-chip"
                    onClick={() => insertMention(member)}
                    disabled={sending}
                    role="option"
                    aria-selected="false"
                  >
                    <Avatar user={member} size={24} />
                    <span>{member.display_name}</span>
                    {isAdmin && <small>管理者</small>}
                  </button>
                );
              })
            )}
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
          className={`mention-toggle-btn${mentionPickerOpen ? " mention-toggle-btn--active" : ""}`}
          aria-label="メンション候補を表示"
          aria-pressed={mentionPickerOpen}
          onClick={() => setMentionPickerOpen((current) => !current)}
          disabled={sending}
        >
          @
        </button>
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
          ref={messageInputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handleMessagePaste}
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
