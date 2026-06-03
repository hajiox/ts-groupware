// /app/board/[id]/page.tsx ver.2
"use client";

import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { linkifyText, OgpPreviews } from "@/components/link-preview";
import { getDeviceHeaders } from "@/lib/device-id";
import { uploadAttachmentFile } from "@/lib/upload-client";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;
const IMAGE_UPLOAD_MAX_SIZE = 1600;
const IMAGE_UPLOAD_QUALITY = 0.82;
const POST_COMPOSER_ID = "post";

type Author = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type Attachment = {
  type: string;
  url: string;
  name: string;
  driveId?: string;
  viewUrl?: string;
  webViewLink?: string;
};

type Post = {
  id: string;
  group_id: string;
  user_id: string;
  parent_id: string | null;
  content: string | null;
  attachments: Attachment[];
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

type BoardMember = Author & {
  role?: string;
  group_role?: string;
};

type MentionState = {
  composerId: string;
  query: string;
  activeIndex: number;
};

function Avatar({ user, size = 38 }: { user: Author; size?: number }) {
  if (user.picture_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={user.picture_url} alt={user.display_name} className="avatar" width={size} height={size} />
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
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();

  if (diff < 60000) return "たった今";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`;

  return date.toLocaleDateString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDriveFileId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "drive.google.com") return null;

    const id = parsed.searchParams.get("id");
    if (id) return id;

    const filePathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
    return filePathMatch?.[1] || null;
  } catch {
    return null;
  }
}

function getAttachmentImageUrl(attachment: Attachment) {
  if (attachment.viewUrl) return attachment.viewUrl;

  const driveId = attachment.driveId || getDriveFileId(attachment.url) || getDriveFileId(attachment.webViewLink || "");
  if (!driveId) return attachment.url;

  return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1200`;
}

function getAttachmentOpenUrl(attachment: Attachment) {
  return attachment.webViewLink || attachment.url || attachment.viewUrl || "#";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commentComposerId(postId: string) {
  return `comment:${postId}`;
}

function commentPostIdFromComposer(composerId: string) {
  return composerId.startsWith("comment:") ? composerId.slice("comment:".length) : null;
}

function getMentionQuery(value: string, caret: number | null | undefined) {
  const beforeCaret = value.slice(0, caret ?? value.length);
  const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);

  return match ? match[2] : null;
}

function hasMentionToken(content: string, displayName: string) {
  return content.includes(`@${displayName}`);
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
  const [commentsByPost, setCommentsByPost] = useState<Record<string, Post[]>>({});
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  const [commentTextByPost, setCommentTextByPost] = useState<Record<string, string>>({});
  const [commentLoadingByPost, setCommentLoadingByPost] = useState<Record<string, boolean>>({});
  const [commentSubmittingByPost, setCommentSubmittingByPost] = useState<Record<string, boolean>>({});
  const [commentFilesByPost, setCommentFilesByPost] = useState<Record<string, File | null>>({});
  const [commentUploadOriginalByPost, setCommentUploadOriginalByPost] = useState<Record<string, boolean>>({});
  const [text, setText] = useState("");
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mentionedIdsByComposer, setMentionedIdsByComposer] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [isPosting, setIsPosting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadOriginal, setUploadOriginal] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [notifMuted, setNotifMuted] = useState(false);
  const [notifToggling, setNotifToggling] = useState(false);
  const [postMutedSettings, setPostMutedSettings] = useState<Record<string, boolean>>({});
  const [postNotifToggling, setPostNotifToggling] = useState<Record<string, boolean>>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const commentSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const commentFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const mentionNames = useMemo(() => (
    [...new Set(members.map((member) => member.display_name).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
  ), [members]);

  useEffect(() => {
    // 初期データを並列取得（/api/groups全件取得を廃止し高速化）
    Promise.all([
      fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/notifications/settings?group_id=${id}`).then((r) => (r.ok ? r.json() : { muted: false })),
    ]).then(([meData, notifData]) => {
      if (meData?.user) setCurrentUser({ id: meData.user.id, role: meData.user.role });
      setNotifMuted(!!notifData?.muted);
    }).catch(() => {});

    loadPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (posts.length === 0) return;
    const postIds = posts.map(p => p.id).join(',');
    fetch(`/api/notifications/posts?post_ids=${postIds}`)
      .then((res) => (res.ok ? res.json() : { settings: {} }))
      .then((data) => {
        setPostMutedSettings(prev => ({ ...prev, ...data.settings }));
      })
      .catch(() => {});
  }, [posts]);

  function loadPosts() {
    setLoading(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);

    fetch(`/api/posts?group_id=${id}`, {
      headers: getDeviceHeaders(),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : { posts: [], groupName: null }))
      .then((data) => {
        setPosts(data.posts || []);
        if (data.groupName) setGroupName(data.groupName);
        if (Array.isArray(data.members)) setMembers(data.members);
      })
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(timeoutId);
        setLoading(false);
      });
  }

  async function uploadFile(file: File, uploadOriginalFile: boolean): Promise<Attachment[]> {
    const preparedFile = await prepareUploadFile(file, uploadOriginalFile);
    const data = await uploadAttachmentFile(preparedFile);

    return [{
      type: data.type,
      url: data.url,
      name: data.name,
      driveId: data.driveId,
      viewUrl: data.viewUrl,
      webViewLink: data.webViewLink,
    }];
  }

  function getMentionCandidates(query: string) {
    const normalizedQuery = query.trim().toLowerCase();

    return members
      .filter((member) => {
        if (!normalizedQuery) return true;
        return member.display_name.toLowerCase().includes(normalizedQuery);
      });
  }

  function updateMentionSearch(composerId: string, value: string, caret: number | null | undefined) {
    const query = getMentionQuery(value, caret);

    if (query === null || members.length === 0) {
      setMentionState((current) => current?.composerId === composerId ? null : current);
      return;
    }

    setMentionState({ composerId, query, activeIndex: 0 });
  }

  function rememberMention(composerId: string, userId: string) {
    setMentionedIdsByComposer((current) => {
      const ids = new Set(current[composerId] || []);
      ids.add(userId);
      return { ...current, [composerId]: [...ids] };
    });
  }

  function clearComposerMentions(composerId: string) {
    setMentionedIdsByComposer((current) => {
      const next = { ...current };
      delete next[composerId];
      return next;
    });
  }

  function getMentionedUserIds(composerId: string, content: string) {
    const ids = new Set<string>();

    for (const userId of mentionedIdsByComposer[composerId] || []) {
      const member = memberById.get(userId);
      if (member && member.id !== currentUser?.id && hasMentionToken(content, member.display_name)) {
        ids.add(member.id);
      }
    }

    for (const member of members) {
      if (member.id !== currentUser?.id && hasMentionToken(content, member.display_name)) {
        ids.add(member.id);
      }
    }

    return [...ids];
  }

  function selectMention(composerId: string, member: BoardMember) {
    const postId = commentPostIdFromComposer(composerId);
    const input = composerId === POST_COMPOSER_ID
      ? textareaRef.current
      : (postId ? commentInputRefs.current[postId] : null);
    const value = composerId === POST_COMPOSER_ID
      ? text
      : (postId ? commentTextByPost[postId] || "" : "");
    const caret = input?.selectionStart ?? value.length;
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);

    if (!match) return;

    const start = beforeCaret.length - match[0].length + match[1].length;
    const suffix = value.slice(caret);
    const spaceAfterMention = suffix.startsWith(" ") ? "" : " ";
    const mentionText = `@${member.display_name}${spaceAfterMention}`;
    const nextValue = `${value.slice(0, start)}${mentionText}${suffix}`;
    const nextCaret = start + mentionText.length;

    if (composerId === POST_COMPOSER_ID) {
      setText(nextValue);
      window.requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCaret, nextCaret);
        textareaRef.current.style.height = "38px";
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      });
    } else if (postId) {
      setCommentTextByPost((current) => ({ ...current, [postId]: nextValue }));
      window.requestAnimationFrame(() => {
        const target = commentInputRefs.current[postId];
        if (!target) return;
        target.focus();
        target.setSelectionRange(nextCaret, nextCaret);
      });
    }

    rememberMention(composerId, member.id);
    setMentionState(null);
  }

  function handleMentionKeyDown(
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    composerId: string,
  ) {
    if (mentionState?.composerId !== composerId) return false;

    const candidates = getMentionCandidates(mentionState.query);
    if (candidates.length === 0) return false;
    const activeIndex = Math.min(mentionState.activeIndex, candidates.length - 1);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionState((current) => current?.composerId === composerId
        ? { ...current, activeIndex: (activeIndex + 1) % candidates.length }
        : current);
      return true;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionState((current) => current?.composerId === composerId
        ? { ...current, activeIndex: (activeIndex - 1 + candidates.length) % candidates.length }
        : current);
      return true;
    }

    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectMention(composerId, candidates[activeIndex]);
      return true;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setMentionState(null);
      return true;
    }

    return false;
  }

  function handlePostTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    updateMentionSearch(POST_COMPOSER_ID, e.target.value, e.target.selectionStart);

    const el = e.target;
    el.style.height = "38px";
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleCommentTextChange(postId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const composerId = commentComposerId(postId);
    setCommentTextByPost((current) => ({ ...current, [postId]: e.target.value }));
    updateMentionSearch(composerId, e.target.value, e.target.selectionStart);
  }

  async function handlePost() {
    if (isPosting || isUploading || (!text.trim() && !selectedFile)) return;

    setIsPosting(true);
    setIsUploading(Boolean(selectedFile));
    try {
      const content = text.trim();
      const attachments = selectedFile ? await uploadFile(selectedFile, uploadOriginal) : [];
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: id,
          content,
          attachments,
          mentioned_user_ids: getMentionedUserIds(POST_COMPOSER_ID, content),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "投稿に失敗しました");
      }

      const data = await res.json().catch(() => null);
      setText("");
      setSelectedFile(null);
      setUploadOriginal(false);
      clearComposerMentions(POST_COMPOSER_ID);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.style.height = "38px";

      if (data?.post) {
        setPosts((current) => [data.post, ...current]);
      } else {
        loadPosts();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "投稿中にエラーが発生しました");
    } finally {
      setIsUploading(false);
      setIsPosting(false);
    }
  }

  async function loadComments(postId: string) {
    setCommentLoadingByPost((current) => ({ ...current, [postId]: true }));
    try {
      const res = await fetch(`/api/posts?group_id=${id}&parent_id=${postId}&limit=100`, { headers: getDeviceHeaders() });
      const data = res.ok ? await res.json() : { posts: [] };
      const comments = (data.posts || [])
        .filter((post: Post) => post.parent_id === postId)
        .sort((a: Post, b: Post) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      setCommentsByPost((current) => ({ ...current, [postId]: comments }));
    } finally {
      setCommentLoadingByPost((current) => ({ ...current, [postId]: false }));
    }
  }

  function openCommentComposer(postId: string) {
    setActiveCommentPostId(postId);

    if (!commentsByPost[postId]) {
      loadComments(postId);
    }

    window.setTimeout(() => {
      commentSectionRefs.current[postId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      window.setTimeout(() => {
        commentInputRefs.current[postId]?.focus();
      }, 80);
    }, 0);
  }

  async function handleComment(postId: string) {
    const composerId = commentComposerId(postId);
    const content = (commentTextByPost[postId] || "").trim();
    const selectedCommentFile = commentFilesByPost[postId] || null;
    const uploadOriginalComment = commentUploadOriginalByPost[postId] || false;
    if (commentSubmittingByPost[postId] || (!content && !selectedCommentFile)) return;

    setCommentSubmittingByPost((current) => ({ ...current, [postId]: true }));
    try {
      const attachments = selectedCommentFile
        ? await uploadFile(selectedCommentFile, uploadOriginalComment)
        : [];

      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: id,
          parent_id: postId,
          content,
          attachments,
          mentioned_user_ids: getMentionedUserIds(composerId, content),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "コメントの投稿に失敗しました");
      }

      const data = await res.json();
      setCommentTextByPost((current) => ({ ...current, [postId]: "" }));
      setCommentFilesByPost((current) => ({ ...current, [postId]: null }));
      setCommentUploadOriginalByPost((current) => ({ ...current, [postId]: false }));
      clearComposerMentions(composerId);
      if (commentFileInputRefs.current[postId]) {
        commentFileInputRefs.current[postId]!.value = "";
      }
      setActiveCommentPostId(postId);
      setCommentsByPost((current) => ({
        ...current,
        [postId]: [...(current[postId] || []), data.post],
      }));
      setPosts((current) => current.map((post) => (
        post.id === postId ? { ...post, commentCount: (post.commentCount || 0) + 1 } : post
      )));
    } catch (err) {
      alert(err instanceof Error ? err.message : "コメントの投稿に失敗しました");
    } finally {
      setCommentSubmittingByPost((current) => ({ ...current, [postId]: false }));
    }
  }

  function applyReaction(post: Post, emoji: string) {
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
  }

  async function handleReaction(postId: string, emoji: string) {
    setPosts((current) => current.map((post) => (
      post.id === postId ? applyReaction(post, emoji) : post
    )));
    setCommentsByPost((current) => Object.fromEntries(
      Object.entries(current).map(([parentId, comments]) => [
        parentId,
        comments.map((comment) => (
          comment.id === postId ? applyReaction(comment, emoji) : comment
        )),
      ])
    ));

    const res = await fetch("/api/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: postId, emoji }),
    });

    if (!res.ok) {
      loadPosts();
      if (activeCommentPostId) loadComments(activeCommentPostId);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (handleMentionKeyDown(e, POST_COMPOSER_ID)) return;

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      handlePost();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setUploadOriginal(false);
  }

  function handleCommentFileChange(postId: string, file: File | null) {
    setCommentFilesByPost((current) => ({ ...current, [postId]: file }));
    setCommentUploadOriginalByPost((current) => ({ ...current, [postId]: false }));
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
    const nextContent = data.post.content;
    setPosts((current) => current.map((item) => (
      item.id === post.id ? { ...item, content: nextContent } : item
    )));
    setCommentsByPost((current) => {
      const next = { ...current };
      for (const postId of Object.keys(next)) {
        next[postId] = next[postId].map((item) => (
          item.id === post.id ? { ...item, content: nextContent } : item
        ));
      }
      return next;
    });
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
    setPosts((current) => current
      .filter((item) => !deletedIds.has(item.id))
      .map((item) => (
        post.parent_id === item.id
          ? { ...item, commentCount: Math.max(0, (item.commentCount || 0) - 1) }
          : item
      )));
    setCommentsByPost((current) => {
      const next = { ...current };
      for (const postId of Object.keys(next)) {
        next[postId] = next[postId].filter((item) => !deletedIds.has(item.id));
      }
      return next;
    });
  }

  function renderMentionSegments(value: string, keyPrefix: string) {
    if (mentionNames.length === 0) return [value];

    const mentionRegex = new RegExp(
      `@(${mentionNames.map(escapeRegExp).join("|")})(?=\\s|$|[、。,.!?！？)）\\]\\}]|\\n)`,
      "g",
    );
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(value)) !== null) {
      if (match.index > lastIndex) {
        parts.push(value.slice(lastIndex, match.index));
      }

      parts.push(
        <span key={`${keyPrefix}-${match.index}`} className="mention-token">
          @{match[1]}
        </span>
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < value.length) {
      parts.push(value.slice(lastIndex));
    }

    return parts.length > 0 ? parts : [value];
  }

  function renderTextWithMentions(value: string) {
    return linkifyText(value).flatMap((part, index) => (
      typeof part === "string" ? renderMentionSegments(part, `mention-${index}`) : [part]
    ));
  }

  function renderMentionMenu(composerId: string) {
    if (mentionState?.composerId !== composerId) return null;

    const candidates = getMentionCandidates(mentionState.query);
    if (candidates.length === 0) return null;
    const activeIndex = Math.min(mentionState.activeIndex, candidates.length - 1);

    return (
      <div className="mention-menu" role="listbox" aria-label="メンション候補">
        {candidates.map((member, index) => (
          <button
            key={member.id}
            type="button"
            className={`mention-option${index === activeIndex ? " mention-option--active" : ""}`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              selectMention(composerId, member);
            }}
          >
            <Avatar user={member} size={26} />
            <span className="mention-option__name">{member.display_name}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderPostBody(post: Post) {
    if (editingPostId === post.id) {
      return (
        <div className="post-card__edit">
          <textarea
            className="post-card__edit-textarea"
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            rows={3}
            aria-label="投稿を編集"
          />
          <div className="post-card__edit-actions">
            <button type="button" className="post-card__edit-btn" onClick={() => saveEdit(post)}>
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
      );
    }

    if (!post.content) return null;

    return (
      <>
        <div className="post-card__body" style={{ whiteSpace: "pre-wrap" }}>
          {renderTextWithMentions(post.content)}
        </div>
        <OgpPreviews text={post.content} />
      </>
    );
  }

  function renderAttachments(post: Post) {
    if (!post.attachments?.length) return null;

    return (
      <div className="post-card__attachments">
        {post.attachments.map((attachment, index) => {
          if (attachment.type?.startsWith("image")) {
            const imageUrl = getAttachmentImageUrl(attachment);

            return (
              <button
                key={`${attachment.name}-${index}`}
                type="button"
                className="post-card__image-button"
                onClick={() => setPreviewImage({ url: imageUrl, name: attachment.name })}
                aria-label={`${attachment.name}を拡大表示`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={attachment.name} className="post-card__image" />
              </button>
            );
          }

          return (
            <a
              key={`${attachment.name}-${index}`}
              href={getAttachmentOpenUrl(attachment)}
              target="_blank"
              rel="noopener noreferrer"
              className="post-card__file"
            >
              📎 {attachment.name}
            </a>
          );
        })}
      </div>
    );
  }

  function renderComment(post: Post) {
    return (
      <article key={post.id} className="post-comment">
        <Avatar user={post.author} size={28} />
        <div className="post-comment__main">
          <div className="post-comment__meta">
            <span>{post.author.display_name}</span>
            <span>{formatDate(post.created_at)}</span>
          </div>
          {renderPostBody(post)}
          {renderAttachments(post)}
          <div className="post-comment__reactions" role="group" aria-label="comment reactions">
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
                  aria-label={`${emoji} ${count}`}
                  aria-pressed={isActive}
                >
                  <span aria-hidden="true">{emoji}</span>
                  {count > 0 && <span>{count}</span>}
                </button>
              );
            })}
          </div>
          {(canEditPost(post) || canDeletePost(post)) && (
            <div className="post-comment__actions">
              {canEditPost(post) && (
                <button type="button" onClick={() => startEditing(post)}>
                  編集
                </button>
              )}
              {canDeletePost(post) && (
                <button type="button" onClick={() => deletePost(post)}>
                  削除
                </button>
              )}
            </div>
          )}
        </div>
      </article>
    );
  }

  function renderCommentComposer(post: Post) {
    const composerId = commentComposerId(post.id);
    const commentFile = commentFilesByPost[post.id] || null;
    const uploadOriginalComment = commentUploadOriginalByPost[post.id] || false;
    const isCommentSubmitting = commentSubmittingByPost[post.id] || false;
    const currentCommentText = commentTextByPost[post.id] || "";

    return (
      <>
        {commentFile && (
          <div className="comment-selected-file">
            <div className="comment-selected-file__main">
              <span className="comment-selected-file__name">📎 {commentFile.name}</span>
              <button
                type="button"
                className="comment-selected-file__remove"
                onClick={() => {
                  setCommentFilesByPost((current) => ({ ...current, [post.id]: null }));
                  setCommentUploadOriginalByPost((current) => ({ ...current, [post.id]: false }));
                  if (commentFileInputRefs.current[post.id]) {
                    commentFileInputRefs.current[post.id]!.value = "";
                  }
                }}
                disabled={isCommentSubmitting}
                aria-label="添付ファイルを削除"
              >
                ×
              </button>
            </div>
            {commentFile.type.startsWith("image/") && (
              <div className="comment-selected-file__mode">
                <span>{uploadOriginalComment ? "元画像のままアップロード" : "縮小してアップロード"}</span>
                <button
                  type="button"
                  className="comment-selected-file__mode-btn"
                  onClick={() => setCommentUploadOriginalByPost((current) => ({
                    ...current,
                    [post.id]: !uploadOriginalComment,
                  }))}
                  disabled={isCommentSubmitting}
                >
                  {uploadOriginalComment ? "縮小に戻す" : "元画像で送る"}
                </button>
              </div>
            )}
          </div>
        )}

        <form
          className="post-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleComment(post.id);
          }}
        >
          <div className="mention-input-wrap">
            {renderMentionMenu(composerId)}
            <input
              ref={(element) => {
                commentInputRefs.current[post.id] = element;
              }}
              value={currentCommentText}
              onChange={(e) => handleCommentTextChange(post.id, e)}
              onKeyDown={(e) => handleMentionKeyDown(e, composerId)}
              placeholder="コメントを入力..."
              aria-label="コメントを入力"
              disabled={isCommentSubmitting}
            />
          </div>
          <input
            type="file"
            ref={(element) => {
              commentFileInputRefs.current[post.id] = element;
            }}
            onChange={(e) => handleCommentFileChange(post.id, e.target.files?.[0] || null)}
            style={{ display: "none" }}
            disabled={isCommentSubmitting}
          />
          <button
            type="button"
            className="comment-attach-btn"
            onClick={() => commentFileInputRefs.current[post.id]?.click()}
            disabled={isCommentSubmitting}
            aria-label="コメントにファイルを添付"
          >
            📎
          </button>
          <button type="submit" disabled={isCommentSubmitting || (!currentCommentText.trim() && !commentFile)}>
            {isCommentSubmitting ? "..." : "送信"}
          </button>
        </form>
      </>
    );
  }

  function renderPost(post: Post) {
    const comments = commentsByPost[post.id] || [];
    const isComposerActive = activeCommentPostId === post.id;
    const isCommentLoading = commentLoadingByPost[post.id] || false;

    return (
      <article key={post.id} className="post-card">
        {post.is_pinned && (
          <div className="post-card__pinned">
            📌 ピン留め
          </div>
        )}

        <header className="post-card__header">
          <Avatar user={post.author} size={40} />
          <div className="post-card__user-info">
            <div className="post-card__username">{post.author.display_name}</div>
            <div className="post-card__time">{formatDate(post.created_at)}</div>
          </div>
          <div className="post-card__actions" aria-label="投稿操作">
            <button
              type="button"
              className="post-card__action-btn"
              onClick={() => togglePostMute(post.id)}
              disabled={postNotifToggling[post.id]}
              title={postMutedSettings[post.id] ? "この投稿の通知はOFFです — タップでON" : "この投稿の通知はONです — タップでOFF"}
            >
              {postMutedSettings[post.id] ? "🔕" : "🔔"}
            </button>
            {canEditPost(post) && (
              <button type="button" className="post-card__action-btn" onClick={() => startEditing(post)}>
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
        </header>

        {renderPostBody(post)}
        {renderAttachments(post)}

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

        <details
          className="post-comments-details"
          open={isComposerActive}
          onToggle={(event) => {
            if (event.currentTarget.open) {
              openCommentComposer(post.id);
            }
          }}
        >
          <summary className="post-card__footer post-comments-summary-inline">
            <span className="post-card__footer-btn">
              💬 {post.commentCount}件のコメント
            </span>
            <span className="post-card__footer-btn">
              コメントする
            </span>
          </summary>
          <section
            className="post-comments"
            aria-label="コメント"
            ref={(element) => {
              commentSectionRefs.current[post.id] = element;
            }}
          >
            {isCommentLoading ? (
              <p className="post-comments__empty">コメントを読み込み中...</p>
            ) : comments.length > 0 ? (
              comments.map(renderComment)
            ) : (
              <p className="post-comments__empty">まだコメントはありません。</p>
            )}
            {renderCommentComposer(post)}
          </section>
        </details>
      </article>
    );
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

  async function togglePostMute(postId: string) {
    const next = !postMutedSettings[postId];
    setPostNotifToggling((prev) => ({ ...prev, [postId]: true }));
    try {
      const res = await fetch("/api/notifications/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: postId, muted: next }),
      });
      if (res.ok) {
        setPostMutedSettings((prev) => ({ ...prev, [postId]: next }));
      }
    } catch (e) {
      console.error("投稿通知設定の変更に失敗", e);
    } finally {
      setPostNotifToggling((prev) => ({ ...prev, [postId]: false }));
    }
  }

  return (
    <div className="board-page">
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

      <section className="post-list" aria-label="投稿一覧">
        {loading ? (
          <p className="post-list__state">読み込み中...</p>
        ) : posts.length === 0 ? (
          <p className="post-list__state">投稿がありません。最初の投稿をしてみましょう。</p>
        ) : (
          posts.map(renderPost)
        )}
      </section>

      <div className="post-input-bar post-input-bar--stacked">
        {selectedFile && (
          <div className="selected-file">
            <div className="selected-file__main">
              <span className="selected-file__name">📎 {selectedFile.name}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setUploadOriginal(false);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="selected-file__remove"
                aria-label="添付ファイルを削除"
                disabled={isPosting || isUploading}
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
                  onClick={() => setUploadOriginal((current) => !current)}
                  disabled={isPosting || isUploading}
                >
                  {uploadOriginal ? "縮小に戻す" : "元画像で送る"}
                </button>
              </div>
            )}
          </div>
        )}

        <form className="post-input-bar__form" onSubmit={(e) => { e.preventDefault(); handlePost(); }} aria-label="新規投稿">
          <div className="mention-input-wrap">
            {renderMentionMenu(POST_COMPOSER_ID)}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handlePostTextChange}
              onKeyDown={handleKeyDown}
              placeholder="投稿内容を入力... @でメンション"
              rows={1}
              aria-label="投稿テキスト"
              disabled={isPosting || isUploading}
            />
          </div>
          <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: "none" }} disabled={isPosting || isUploading} />
          <button
            type="button"
            className="icon-btn"
            aria-label="ファイルを添付"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPosting || isUploading}
          >
            📎
          </button>
          <button
            type="submit"
            className="send-btn"
            aria-label="投稿を送信"
            disabled={isPosting || isUploading || (!text.trim() && !selectedFile)}
          >
            {isPosting || isUploading ? "..." : "↑"}
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
    </div>
  );
}
