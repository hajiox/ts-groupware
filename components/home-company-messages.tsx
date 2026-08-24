"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, History, ImagePlus, Megaphone, Send, X } from "lucide-react";

type MessageAttachment = {
  url: string;
  viewUrl?: string;
  webViewLink?: string;
  name: string;
  type: string;
  driveId?: string;
};

type CompanyMessage = {
  id: string;
  author_user_id: string;
  author_name: string;
  title: string;
  body: string;
  attachment: MessageAttachment | null;
  created_at: string;
};

function formatSentAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSentDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

function messageTitle(message: CompanyMessage) {
  return message.title?.trim()
    || message.body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 80)
    || "全社員メッセージ";
}

function CompanyMessageComposer({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent: (message: CompanyMessage, recipientCount: number) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(imageFile);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [imageFile]);

  useEffect(() => {
    if (open) return;
    setTitle("");
    setBody("");
    setImageFile(null);
    setError("");
  }, [open]);

  if (!open) return null;

  function selectImage(file: File | null) {
    setError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選択してください");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("画像は20MB以内にしてください");
      return;
    }
    setImageFile(file);
  }

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !title.trim() || !body.trim()) return;
    setSending(true);
    setError("");

    try {
      let attachment: MessageAttachment | null = null;
      if (imageFile) {
        const formData = new FormData();
        formData.append("file", imageFile);
        const uploadResponse = await fetch("/api/upload", { method: "POST", body: formData });
        const uploadData = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok) throw new Error(uploadData.error || "画像をアップロードできませんでした");
        attachment = {
          url: uploadData.url,
          viewUrl: uploadData.viewUrl,
          webViewLink: uploadData.webViewLink,
          name: uploadData.name || imageFile.name,
          type: uploadData.type || imageFile.type,
          driveId: uploadData.driveId,
        };
      }

      const response = await fetch("/api/home-company-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), attachment }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "全社員メッセージを送信できませんでした");

      onSent(data.message, Number(data.recipient_count || 0));
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "全社員メッセージを送信できませんでした");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-overlay company-message-modal" onClick={onClose}>
      <div
        className="modal-content company-message-modal__content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-message-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="company-message-modal__header">
          <div>
            <span>ホームへ掲載</span>
            <h2 id="company-message-title">全社員メッセージ</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="閉じる" disabled={sending}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={submitMessage}>
          <label className="company-message-modal__title">
            <span>タイトル</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例：8月の社内連絡"
              maxLength={80}
              autoFocus
            />
          </label>

          <label className="company-message-modal__body">
            <span>メッセージ</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="全社員へ伝える内容を入力"
              maxLength={5000}
              rows={7}
            />
          </label>

          {previewUrl && (
            <div className="company-message-modal__preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="添付画像のプレビュー" />
              <button type="button" onClick={() => setImageFile(null)} aria-label="添付画像を外す">
                <X size={18} />
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => selectImage(event.target.files?.[0] || null)}
          />

          {error && <p className="company-message-modal__error">{error}</p>}

          <div className="company-message-modal__actions">
            <button
              type="button"
              className="company-message-modal__image"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
            >
              <ImagePlus size={18} /> 画像
            </button>
            <button type="submit" className="company-message-modal__send" disabled={sending || !title.trim() || !body.trim()}>
              <Send size={18} /> {sending ? "送信中..." : "全社員へ送信"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function HomeCompanyMessages({ mode }: { mode: "composer" | "inbox" | "history" }) {
  const [messages, setMessages] = useState<CompanyMessage[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedMessageId, setExpandedMessageId] = useState("");
  const [dismissingId, setDismissingId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const loadMessages = useCallback(() => {
    const endpoint = mode === "history"
      ? "/api/home-company-messages?view=history"
      : "/api/home-company-messages";
    fetch(endpoint, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { messages: [], canCreate: false }))
      .then((data) => {
        setMessages(data.messages || []);
        setCanCreate(Boolean(data.canCreate));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [mode]);

  useEffect(() => {
    loadMessages();
    const timer = window.setInterval(loadMessages, 60000);
    window.addEventListener("focus", loadMessages);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", loadMessages);
    };
  }, [loadMessages]);

  async function dismissMessage(messageId: string) {
    if (dismissingId) return;
    if (!window.confirm("このメッセージをホームに表示しないようにしますか？")) return;
    setDismissingId(messageId);
    try {
      const response = await fetch("/api/home-company-messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "メッセージを非表示にできませんでした");
      setMessages((current) => current.filter((message) => message.id !== messageId));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "メッセージを非表示にできませんでした");
    } finally {
      setDismissingId("");
    }
  }

  if (mode === "composer" && !canCreate) return null;
  if (mode === "inbox" && loaded && messages.length === 0) return null;

  return (
    <section className={`company-messages company-messages--${mode}`} aria-label="全社員メッセージ">
      {mode === "composer" && canCreate && (
        <div className="company-messages__author-bar">
          <div>
            <Megaphone size={18} />
            <strong>全社員メッセージ</strong>
          </div>
          <button type="button" onClick={() => setComposerOpen(true)}>
            <Send size={16} /> 新規送信
          </button>
        </div>
      )}

      {mode === "composer" && statusMessage && <p className="company-messages__status">{statusMessage}</p>}

      {mode === "history" && (
        <div className="company-message-history">
          <header className="company-message-history__header">
            <div>
              <History size={18} />
              <div>
                <strong>全社員メッセージ履歴</strong>
                <span>ホームで非表示にした連絡も確認できます</span>
              </div>
            </div>
            {loaded && <small>{messages.length}件</small>}
          </header>

          {!loaded ? (
            <p className="company-message-history__empty">履歴を読み込み中...</p>
          ) : messages.length === 0 ? (
            <p className="company-message-history__empty">配信履歴はありません</p>
          ) : (
            <div className="company-message-history__list">
              {messages.map((message) => {
                const expanded = expandedMessageId === message.id;
                const attachment = message.attachment;
                const imageUrl = attachment?.viewUrl || attachment?.url || "";
                const openUrl = attachment?.webViewLink || attachment?.url || imageUrl;
                return (
                  <article className={`company-message-history__item${expanded ? " is-open" : ""}`} key={message.id}>
                    <button
                      type="button"
                      className="company-message-history__summary"
                      aria-expanded={expanded}
                      onClick={() => setExpandedMessageId(expanded ? "" : message.id)}
                    >
                      <time dateTime={message.created_at}>{formatSentDate(message.created_at)}</time>
                      <strong>{messageTitle(message)}</strong>
                      <ChevronDown size={17} aria-hidden="true" />
                    </button>
                    {expanded && (
                      <div className="company-message-history__body">
                        <small>{message.author_name} / {formatSentAt(message.created_at)}</small>
                        <p>{message.body}</p>
                        {attachment && imageUrl && (
                          <a href={openUrl} target="_blank" rel="noreferrer" className="company-message-card__image">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={imageUrl} alt={attachment.name || "添付画像"} />
                          </a>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {mode === "inbox" && (
        <div className="company-messages__list">
          {messages.map((message) => {
            const attachment = message.attachment;
            const imageUrl = attachment?.viewUrl || attachment?.url || "";
            const openUrl = attachment?.webViewLink || attachment?.url || imageUrl;
            return (
              <article key={message.id} className="company-message-card">
                <header>
                  <div>
                    <span>{messageTitle(message)}</span>
                    <time dateTime={message.created_at}>{formatSentAt(message.created_at)}</time>
                  </div>
                  <button
                    type="button"
                    onClick={() => void dismissMessage(message.id)}
                    disabled={Boolean(dismissingId)}
                  >
                    <X size={15} /> {dismissingId === message.id ? "処理中" : "表示しない"}
                  </button>
                </header>
                <p>{message.body}</p>
                {attachment && imageUrl && (
                  <a href={openUrl} target="_blank" rel="noreferrer" className="company-message-card__image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUrl} alt={attachment.name || "添付画像"} />
                  </a>
                )}
              </article>
            );
          })}
        </div>
      )}

      {mode === "composer" && (
        <CompanyMessageComposer
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          onSent={(_message, recipientCount) => {
            setStatusMessage(`${recipientCount}名（本人を含む）へ送信しました`);
            window.setTimeout(() => setStatusMessage(""), 2500);
          }}
        />
      )}
    </section>
  );
}
