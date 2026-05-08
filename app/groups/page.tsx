"use client";

import Link from "next/link";
import { MOCK_GROUPS, CURRENT_USER } from "@/lib/mock-data";

function AvatarPlaceholder({
  initials,
  color,
  size = 36,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

export default function GroupsPage() {
  return (
    <>
      {/* Header */}
      <header className="groups-header" role="banner">
        <span className="groups-header__logo">TS Groupware</span>
        <div className="groups-header__user">
          <span style={{ fontSize: 14, color: "var(--text-sub)" }}>{CURRENT_USER.name}</span>
          <AvatarPlaceholder
            initials={CURRENT_USER.initials}
            color={CURRENT_USER.color}
            size={34}
          />
        </div>
      </header>

      {/* Group list */}
      <section
        className="groups-list page-content"
        aria-label="グループ一覧"
        style={{ paddingTop: 16 }}
      >
        {MOCK_GROUPS.map((group) => {
          const href =
            group.type === "board" ? `/board/${group.id}` : `/chat/${group.id}`;
          return (
            <Link key={group.id} href={href} aria-label={`${group.name}を開く`}>
              <article className="group-card">
                <div
                  className={`group-card__icon group-card__icon--${group.type}`}
                  aria-hidden="true"
                >
                  {group.icon}
                </div>

                <div className="group-card__info">
                  <div className="group-card__name">{group.name}</div>
                  <div className="group-card__meta">
                    <span
                      className={`group-card__type-tag group-card__type-tag--${group.type}`}
                    >
                      {group.type === "board" ? "掲示板" : "チャット"}
                    </span>
                    {group.lastMessage}
                  </div>
                </div>

                <div className="group-card__right">
                  <span className="group-card__time">{group.updatedAt.split(" ")[1]}</span>
                  {group.unread > 0 && (
                    <span className="badge" aria-label={`未読${group.unread}件`}>
                      {group.unread}
                    </span>
                  )}
                </div>
              </article>
            </Link>
          );
        })}
      </section>

      {/* FAB */}
      <button
        type="button"
        className="fab"
        aria-label="グループを新規作成"
        onClick={() => alert("グループ作成機能は近日公開予定です")}
      >
        +
      </button>
    </>
  );
}
