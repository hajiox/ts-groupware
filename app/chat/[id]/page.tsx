"use client";

import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { MOCK_GROUPS, MOCK_MESSAGES, MOCK_USERS } from "@/lib/mock-data";

function AvatarPlaceholder({
  initials,
  color,
  size = 32,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const group = MOCK_GROUPS.find((g) => g.id === id);
  const initialMessages = MOCK_MESSAGES.filter((m) => m.groupId === id);

  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;

    const newMsg = {
      id: `msg-${Date.now()}`,
      groupId: id,
      author: MOCK_USERS[0],
      createdAt: new Date().toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      text: trimmed,
      imageUrl: null,
      isOwn: true,
    };

    setMessages((prev) => [...prev, newMsg]);
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
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
        <h1 className="top-header__title">{group?.name ?? "チャット"}</h1>
        <span className="top-header__meta">{MOCK_USERS.length}名</span>
      </header>

      {/* Messages */}
      <section
        className="chat-messages"
        aria-label="チャットメッセージ"
        role="log"
        aria-live="polite"
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`msg msg--${msg.isOwn ? "own" : "other"}`}
            aria-label={`${msg.isOwn ? "自分" : msg.author.name}: ${msg.text} ${msg.createdAt}`}
          >
            {/* Avatar (others only) */}
            {!msg.isOwn && (
              <div className="msg__avatar-col">
                <AvatarPlaceholder
                  initials={msg.author.initials}
                  color={msg.author.color}
                  size={30}
                />
              </div>
            )}

            {/* Bubble + name */}
            <div style={{ display: "flex", flexDirection: "column", maxWidth: "100%" }}>
              {!msg.isOwn && (
                <span className="msg__name">{msg.author.name}</span>
              )}
              <div className="msg__bubble">{msg.text}</div>
              {msg.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={msg.imageUrl} alt="画像メッセージ" className="msg__image" />
              )}
            </div>

            {/* Timestamp */}
            <time className="msg__time" dateTime={msg.createdAt}>
              {msg.createdAt}
            </time>
          </div>
        ))}

        {messages.length === 0 && (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            メッセージはまだありません。最初のメッセージを送りましょう！
          </p>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} aria-hidden="true" />
      </section>

      {/* Chat input bar */}
      <form
        className="chat-input-bar"
        onSubmit={(e) => { e.preventDefault(); handleSend(); }}
        aria-label="メッセージ入力"
      >
        <button type="button" className="icon-btn" aria-label="画像を添付">
          📎
        </button>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="メッセージを入力…"
          aria-label="メッセージ"
          autoComplete="off"
        />
        <button
          type="submit"
          className="send-btn"
          aria-label="送信"
          disabled={!input.trim()}
        >
          ↑
        </button>
      </form>
    </>
  );
}
