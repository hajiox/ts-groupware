"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type User = {
  id: string;
  display_name: string;
  real_name: string | null;
  picture_url: string | null;
  role: string;
  status: "pending" | "approved" | "suspended";
  created_at: string;
};

type Group = {
  id: string;
  name: string;
  type: "board" | "chat";
  icon: string;
};

type GroupMember = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
  group_role: string;
  implicit_member?: boolean;
};

type Tab = "users" | "groups";

function isAllStaffGroupName(name: string) {
  const normalized = name.replace(/\s+/g, "");
  return normalized.includes("オールスタッフ") || normalized.includes("全スタッフ");
}

function Avatar({ user, size = 36 }: { user: { display_name: string; picture_url: string | null }; size?: number }) {
  if (user.picture_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.picture_url} alt={user.display_name} className="avatar" width={size} height={size} />;
  }
  return (
    <div className="avatar-placeholder" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {user.display_name?.charAt(0) || "?"}
    </div>
  );
}

// ─── ユーザー管理タブ ───
function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  function loadUsers() {
    setLoading(true);
    fetch("/api/admin/users")
      .then(r => r.ok ? r.json() : { users: [] })
      .then(d => {
        const nextUsers = d.users || [];
        setUsers(nextUsers);
        setNameDrafts(Object.fromEntries(nextUsers.map((nextUser: User) => [nextUser.id, nextUser.real_name || ""])));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadUsers(); }, []);

  async function handleRoleChange(userId: string, newRole: string) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role: newRole }),
    });
    if (res.ok) loadUsers();
    else alert("ロールの変更に失敗しました");
  }

  async function handleStatusChange(userId: string, newStatus: User["status"]) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, status: newStatus }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "承認状態の変更に失敗しました");
    }
  }

  async function handleRealNameSave(user: User) {
    const nextName = (nameDrafts[user.id] || "").trim();
    if (nextName === (user.real_name || "")) return;

    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, real_name: nextName || null }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "本名の保存に失敗しました");
    }
  }

  async function handleDelete(user: User) {
    if (!confirm(`${user.display_name} を削除しますか？この操作は取り消せません。`)) return;
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    if (res.ok) loadUsers();
    else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "削除に失敗しました");
    }
  }

  if (loading) return <p className="admin-empty">読み込み中...</p>;

  return (
    <div className="admin-list">
      {users.map(user => (
        <div key={user.id} className="admin-item">
          <Avatar user={user} size={40} />
          <div className="admin-item__info">
            <div className="admin-item__name">
              {user.display_name}
            </div>
            <div className="admin-name-editor">
              <input
                type="text"
                className="form-input"
                placeholder="本名 (任意)"
                value={nameDrafts[user.id] ?? (user.real_name || "")}
                onChange={e => setNameDrafts(current => ({ ...current, [user.id]: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === "Enter") handleRealNameSave(user);
                }}
                aria-label={`${user.display_name} の本名`}
              />
              <button
                type="button"
                className="admin-btn-outline"
                onClick={() => handleRealNameSave(user)}
                disabled={(nameDrafts[user.id] ?? (user.real_name || "")).trim() === (user.real_name || "")}
              >
                保存
              </button>
            </div>
            <div className="admin-item__sub">
              {new Date(user.created_at).toLocaleDateString("ja-JP")} 登録
              <span className={`admin-status admin-status--${user.status || "approved"}`}>
                {user.status === "pending" ? "承認待ち" : user.status === "suspended" ? "停止中" : "承認済み"}
              </span>
            </div>
          </div>
          <div className="admin-item__actions">
            {user.status === "pending" && (
              <button
                type="button"
                className="admin-btn-accent"
                onClick={() => handleStatusChange(user.id, "approved")}
              >
                承認
              </button>
            )}
            {user.status === "approved" && (
              <button
                type="button"
                className="admin-btn-outline"
                onClick={() => handleStatusChange(user.id, "suspended")}
              >
                停止
              </button>
            )}
            {user.status === "suspended" && (
              <button
                type="button"
                className="admin-btn-accent"
                onClick={() => handleStatusChange(user.id, "approved")}
              >
                再開
              </button>
            )}
            <select
              value={user.role}
              onChange={e => handleRoleChange(user.id, e.target.value)}
              className="admin-select"
            >
              <option value="admin">管理者</option>
              <option value="member">スタッフ</option>
            </select>
            <button
              type="button"
              className="admin-btn-danger"
              onClick={() => handleDelete(user)}
              title="削除"
            >
              🗑
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── グループ管理タブ ───
function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [nonMembers, setNonMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupType, setNewGroupType] = useState<"board" | "chat">("board");
  const [newGroupIcon, setNewGroupIcon] = useState("📢");
  const [newGroupAddAllMembers, setNewGroupAddAllMembers] = useState(false);
  const [creating, setCreating] = useState(false);

  function loadGroups() {
    setLoading(true);
    fetch("/api/groups")
      .then(r => r.ok ? r.json() : { groups: [] })
      .then(d => setGroups(d.groups))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadGroups(); }, []);

  async function loadMembers(group: Group) {
    setSelectedGroup(group);
    setMembersLoading(true);
    const res = await fetch(`/api/admin/members?group_id=${group.id}`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members || []);
      setNonMembers(data.nonMembers || []);
    }
    setMembersLoading(false);
  }

  async function handleDeleteGroup(group: Group) {
    if (!confirm(`「${group.name}」を削除しますか？投稿もすべて削除されます。`)) return;
    const res = await fetch("/api/admin/groups", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: group.id }),
    });
    if (res.ok) {
      setSelectedGroup(null);
      loadGroups();
    } else alert("グループの削除に失敗しました");
  }

  async function handleAddMember(userId: string) {
    if (!selectedGroup) return;
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_ids: [userId] }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("メンバーの追加に失敗しました");
  }

  async function handleAddAllMembers() {
    if (!selectedGroup || nonMembers.length === 0) return;
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_ids: nonMembers.map(u => u.id) }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("メンバーの追加に失敗しました");
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedGroup) return;
    const res = await fetch("/api/admin/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, user_id: userId }),
    });
    if (res.ok) loadMembers(selectedGroup);
    else alert("メンバーの削除に失敗しました");
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newGroupName.trim(),
        type: newGroupType,
        icon: newGroupIcon,
        add_all_members: newGroupAddAllMembers,
      }),
    });
    if (res.ok) {
      setNewGroupName("");
      setNewGroupAddAllMembers(false);
      setShowCreate(false);
      loadGroups();
    } else alert("グループの作成に失敗しました");
    setCreating(false);
  }

  const icons = ["📢", "💻", "💬", "📋", "🎯", "🏠", "📦", "🔧", "📊", "🎨"];

  function openCreateForm(type: "board" | "chat") {
    setNewGroupType(type);
    setNewGroupIcon(type === "chat" ? "💬" : "📢");
    setNewGroupAddAllMembers(false);
    setShowCreate(true);
  }

  if (loading) return <p className="admin-empty">読み込み中...</p>;

  // メンバー管理画面
  if (selectedGroup) {
    return (
      <div>
        <button type="button" className="admin-back-btn" onClick={() => setSelectedGroup(null)}>
          ← グループ一覧に戻る
        </button>
        <div className="admin-section-header">
          <span style={{ fontSize: 24 }}>{selectedGroup.icon}</span>
          <h3 className="admin-section-title">{selectedGroup.name}</h3>
          <button
            type="button"
            className="admin-btn-danger"
            onClick={() => handleDeleteGroup(selectedGroup)}
            style={{ marginLeft: "auto" }}
          >
            🗑 削除
          </button>
        </div>

        {membersLoading ? (
          <p className="admin-empty">読み込み中...</p>
        ) : (
          <>
            {/* 参加中メンバー */}
            <h4 className="admin-sub-title">
              参加中 ({members.length})
            </h4>
            <div className="admin-list">
              {members.length === 0 ? (
                <p className="admin-empty">メンバーがいません</p>
              ) : (
                members.map(m => (
                  <div key={m.id} className="admin-item">
                    <Avatar user={m} size={34} />
                    <div className="admin-item__info">
                      <div className="admin-item__name">{m.display_name}</div>
                      <div className="admin-item__sub">
                        {m.role === "admin" ? "管理者" : "スタッフ"}
                        {m.implicit_member ? "・自動参加" : ""}
                      </div>
                    </div>
                    {m.role === "admin" ? (
                      <span className="admin-member-lock">全グループ参加</span>
                    ) : (
                      <button
                        type="button"
                        className="admin-btn-outline"
                        onClick={() => handleRemoveMember(m.id)}
                      >
                        除外
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* 未参加ユーザー */}
            <h4 className="admin-sub-title" style={{ marginTop: 16 }}>
              未参加 ({nonMembers.length})
              {nonMembers.length > 0 && (
                <button type="button" className="admin-btn-small" onClick={handleAddAllMembers}>
                  全員追加
                </button>
              )}
            </h4>
            <div className="admin-list">
              {nonMembers.length === 0 ? (
                <p className="admin-empty">全員が参加しています</p>
              ) : (
                nonMembers.map(u => (
                  <div key={u.id} className="admin-item">
                    <Avatar user={u} size={34} />
                    <div className="admin-item__info">
                      <div className="admin-item__name">{u.display_name}</div>
                      <div className="admin-item__sub">{u.role === "admin" ? "管理者" : "スタッフ"}</div>
                    </div>
                    <button
                      type="button"
                      className="admin-btn-accent"
                      onClick={() => handleAddMember(u.id)}
                    >
                      追加
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // グループ一覧
  return (
    <div>
      <div className="admin-create-actions">
        <button type="button" className="admin-create-btn" onClick={() => openCreateForm("board")}>
          ＋ 掲示板を作成
        </button>
        <button type="button" className="admin-create-btn admin-create-btn--chat" onClick={() => openCreateForm("chat")}>
          ＋ Chatを作成
        </button>
      </div>

      {showCreate && (
        <form className="admin-create-form" onSubmit={handleCreateGroup}>
          <div className="admin-create-form__title">
            {newGroupType === "chat" ? "新規Chat作成" : "新規掲示板作成"}
          </div>
          <input
            type="text"
            className="form-input"
            value={newGroupName}
            onChange={e => {
              const nextName = e.target.value;
              setNewGroupName(nextName);
              if (isAllStaffGroupName(nextName)) setNewGroupAddAllMembers(true);
            }}
            placeholder={newGroupType === "chat" ? "Chat名" : "掲示板名"}
            autoFocus
          />
          <div className="type-selector" style={{ marginTop: 8 }}>
            <button type="button" className={`type-btn ${newGroupType === "board" ? "type-btn--active" : ""}`} onClick={() => setNewGroupType("board")}>📋 掲示板</button>
            <button type="button" className={`type-btn ${newGroupType === "chat" ? "type-btn--active" : ""}`} onClick={() => setNewGroupType("chat")}>💬 チャット</button>
          </div>
          <div className="icon-grid" style={{ marginTop: 8 }}>
            {icons.map(ic => (
              <button key={ic} type="button" className={`icon-select-btn ${newGroupIcon === ic ? "icon-select-btn--active" : ""}`} onClick={() => setNewGroupIcon(ic)}>{ic}</button>
            ))}
          </div>
          <label className="form-check" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={newGroupAddAllMembers}
              onChange={e => setNewGroupAddAllMembers(e.target.checked)}
            />
            <span>承認済みスタッフ全員をメンバーに追加</span>
          </label>
          <div className="admin-form-actions">
            <button type="button" className="btn-cancel" onClick={() => setShowCreate(false)}>キャンセル</button>
            <button type="submit" className="btn-primary" disabled={creating || !newGroupName.trim()}>
              {creating ? "作成中..." : "作成"}
            </button>
          </div>
        </form>
      )}

      <div className="admin-list" style={{ marginTop: showCreate ? 16 : 0 }}>
        {groups.length === 0 ? (
          <p className="admin-empty">グループがありません</p>
        ) : (
          groups.map(group => {
            const groupType = group.type === "chat" ? "chat" : "board";
            return (
            <div key={group.id} className={`admin-item admin-item--clickable admin-group-card admin-group-card--${groupType}`} onClick={() => loadMembers(group)}>
              <div className={`group-card__icon group-card__icon--${groupType}`} style={{ width: 40, height: 40, borderRadius: 10, fontSize: 20 }}>
                {group.icon}
              </div>
              <div className="admin-item__info">
                <div className="admin-item__name">{group.name}</div>
                <div className="admin-item__sub">{group.type === "board" ? "掲示板" : "チャット"}</div>
              </div>
              <span className="admin-group-card__manage">メンバー管理 →</span>
            </div>
          )})
        )}
      </div>
    </div>
  );
}

// ─── メインページ ───
export default function AdminPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("users");
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.user || data.user.role !== "admin") {
          router.replace("/groups");
          return;
        }
        setCurrentUser(data.user);
        setAuthChecking(false);
      })
      .catch(() => router.replace("/groups"));
  }, [router]);

  if (authChecking) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-sub)" }}>
        読み込み中...
      </div>
    );
  }

  return (
    <>
      <header className="top-header" role="banner">
        <button type="button" className="top-header__back" onClick={() => router.push("/groups")} aria-label="戻る">‹</button>
        <h1 className="top-header__title">管理</h1>
        <span className="top-header__meta">{currentUser?.display_name}</span>
      </header>

      <div className="admin-page page-content">
        {/* タブ */}
        <div className="admin-tabs">
          <button
            type="button"
            className={`admin-tab ${tab === "users" ? "admin-tab--active" : ""}`}
            onClick={() => setTab("users")}
          >
            👤 ユーザー
          </button>
          <button
            type="button"
            className={`admin-tab ${tab === "groups" ? "admin-tab--active" : ""}`}
            onClick={() => setTab("groups")}
          >
            👥 グループ
          </button>
        </div>

        {tab === "users" ? <UsersTab /> : <GroupsTab />}
      </div>
    </>
  );
}
