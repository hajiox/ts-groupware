"use client";

import { useEffect, useState } from "react";

type Member = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
  isSelf?: boolean;
};

function AvatarPlaceholder({
  initials,
  size = 38,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingChatUserId, setCreatingChatUserId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/chat/direct")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("メンバー一覧を取得できませんでした")))
      .then(data => setMembers(data.users || []))
      .catch(err => setError(err instanceof Error ? err.message : "メンバー一覧を取得できませんでした"))
      .finally(() => setLoading(false));
  }, []);

  async function startDirectChat(targetUserId: string) {
    setCreatingChatUserId(targetUserId);
    setError("");

    const res = await fetch("/api/chat/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_user_id: targetUserId }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.group?.id) {
      window.location.href = `/chat/${data.group.id}`;
      return;
    }

    setError(data.error || "個人Chatの開始に失敗しました");
    setCreatingChatUserId("");
  }

  return (
    <>
      <header className="top-header" role="banner">
        <h1 className="top-header__title">DM</h1>
        <span className="top-header__meta">{members.length}名</span>
      </header>

      <section className="members-page page-content" aria-label="メンバー一覧">
        <div className="chat-privacy-banner">
          <span className="chat-privacy-banner__icon" aria-hidden="true">🔒</span>
          <span>個人チャットは安全に保護されています。通信はすべて暗号化され、会話内容が第三者に共有されることはありません。</span>
        </div>
        {loading ? (
          <p className="member-directory__empty">読み込み中...</p>
        ) : error ? (
          <p className="member-directory__error">{error}</p>
        ) : members.length === 0 ? (
          <p className="member-directory__empty">表示できるメンバーがいません</p>
        ) : (
          <div className="member-directory__list member-directory__list--page">
            {members.map(member => (
              <button
                key={member.id}
                type="button"
                className="member-directory__item"
                onClick={() => startDirectChat(member.id)}
                disabled={Boolean(creatingChatUserId)}
                title={member.isSelf ? "自分用メモを開く" : `${member.display_name} とChat`}
              >
                {member.picture_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={member.picture_url} alt="" className="avatar" width={38} height={38} />
                ) : (
                  <AvatarPlaceholder initials={member.display_name.charAt(0)} />
                )}
                <span>
                  {member.isSelf ? `${member.display_name}（自分用メモ）` : member.display_name}
                  {member.display_name === "TSG君" && (
                    <span className="group-card__ai-badge">🤖 AIへの相談はこちらへ！</span>
                  )}
                </span>
                <span className="member-directory__chat">
                  {creatingChatUserId === member.id ? "開始中..." : member.isSelf ? "メモ" : "Chat"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
