"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ImageAnnotationEditor } from "@/components/image-annotation-editor";
import { linkifyText, OgpPreviews } from "@/components/link-preview";
import { ReadReceiptAvatars, type ReadReceiptUser } from "@/components/read-receipt-avatars";
import { SafeLineAvatar } from "@/components/safe-line-avatar";
import { getClipboardImageFile } from "@/lib/clipboard-image";
import { getDeviceHeaders } from "@/lib/device-id";
import { USER_DEPARTMENTS, type UserDepartment } from "@/lib/departments";
import { formatMentionName, mentionDisplayName } from "@/lib/mention-names";
import { REACTION_EMOJIS } from "@/lib/reactions";
import { getEffectiveUserRole, getUserRoleLabel, isManagementRole } from "@/lib/user-roles";

const IMAGE_UPLOAD_MAX_SIZE = 1600;
const IMAGE_UPLOAD_QUALITY = 0.82;
const POSTS_PAGE_LIMIT = 50;
const COMMENT_PREVIEW_LIMIT = 5;

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
  reply_to_id?: string | null;
  reply_to?: {
    id: string;
    display_name: string;
  } | null;
  content: string | null;
  attachments: Attachment[];
  created_at: string;
  is_pinned: boolean;
  author: Author;
  reactions: Record<string, { count: number; hasOwn: boolean }>;
  commentCount: number;
  commentPreview?: Post[];
  tasks?: TaskSummary[];
};

type CurrentUser = {
  id: string;
  role: string;
};

type TaskSummary = {
  id: string;
  post_id: string;
  group_id: string;
  requester_id: string;
  assignee_id: string;
  due_date: string;
  completed_at: string | null;
  completed_by: string | null;
  canceled_at?: string | null;
  canceled_by?: string | null;
  cancel_reason?: string | null;
  assignee?: Author | null;
  requester?: Author | null;
  completedBy?: Author | null;
};

type GroupMember = Author & {
  groupRole?: string;
  role?: string;
  department?: UserDepartment;
  isSelf?: boolean;
};

function isAdminMember(member: GroupMember) {
  return isManagementRole(getEffectiveUserRole(member)) || member.groupRole === "admin";
}

function memberPermissionLabel(member: GroupMember) {
  if (isManagementRole(getEffectiveUserRole(member))) return getUserRoleLabel(member);
  if (member.groupRole === "admin") return "グループ管理者";
  return null;
}

function sortTaskMembers(members: GroupMember[]) {
  return [...members].sort((a, b) => {
    const aIsAdmin = isAdminMember(a);
    const bIsAdmin = isAdminMember(b);
    if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1;
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.display_name.localeCompare(b.display_name, "ja");
  });
}

function sortBoardPosts(posts: Post[]) {
  return [...posts].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function Avatar({ user, size = 38 }: { user: Author; size?: number }) {
  return <SafeLineAvatar name={user.display_name} pictureUrl={user.picture_url} size={size} />;
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

function formatDueDate(dateStr: string) {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
}

function todayDateInputValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

function getCompressedImageName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, "");
  return `${baseName || "image"}.jpg`;
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types || []).includes("Files");
}

function getFirstDroppedFile(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files || [])[0] || null;
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
  const [readReceipts, setReadReceipts] = useState<ReadReceiptUser[]>([]);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, Post[]>>({});
  const [expandedCommentsByPost, setExpandedCommentsByPost] = useState<Record<string, boolean>>({});
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  const [commentTextByPost, setCommentTextByPost] = useState<Record<string, string>>({});
  const [commentLoadingByPost, setCommentLoadingByPost] = useState<Record<string, boolean>>({});
  const [commentSubmittingByPost, setCommentSubmittingByPost] = useState<Record<string, boolean>>({});
  const [commentFilesByPost, setCommentFilesByPost] = useState<Record<string, File | null>>({});
  const [commentUploadOriginalByPost, setCommentUploadOriginalByPost] = useState<Record<string, boolean>>({});
  const [replyTargetByPost, setReplyTargetByPost] = useState<Record<string, Post | null>>({});
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(false);
  const [postingDisabled, setPostingDisabled] = useState(false);
  const [postingDisabledMessage, setPostingDisabledMessage] = useState("");
  const [isPosting, setIsPosting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadOriginal, setUploadOriginal] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [annotatingImage, setAnnotatingImage] = useState<{ post: Post; attachment: Attachment; attachmentIndex: number } | null>(null);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingTaskAssigneeIds, setEditingTaskAssigneeIds] = useState<string[]>([]);
  const [editingTaskDueDate, setEditingTaskDueDate] = useState("");
  const [notifMuted, setNotifMuted] = useState(false);
  const [notifToggling, setNotifToggling] = useState(false);
  const [postMutedSettings, setPostMutedSettings] = useState<Record<string, boolean>>({});
  const [postNotifToggling, setPostNotifToggling] = useState<Record<string, boolean>>({});
  const [pinTogglingByPost, setPinTogglingByPost] = useState<Record<string, boolean>>({});
  const [expandedPinnedPosts, setExpandedPinnedPosts] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [taskEnabled, setTaskEnabled] = useState(false);
  const [taskMembers, setTaskMembers] = useState<GroupMember[]>([]);
  const [taskMembersLoading, setTaskMembersLoading] = useState(false);
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>([]);
  const [taskDueDate, setTaskDueDate] = useState("");
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [commentMentionPickerPostId, setCommentMentionPickerPostId] = useState<string | null>(null);
  const [postDropActive, setPostDropActive] = useState(false);
  const [commentDropActivePostId, setCommentDropActivePostId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const commentSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const commentFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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

  useEffect(() => {
    if (!taskEnabled) return;
    if (!taskDueDate) setTaskDueDate(todayDateInputValue());
    void loadGroupMembers();
  }, [id, taskEnabled, taskDueDate, taskMembers.length, taskMembersLoading]);

  const filteredPosts = posts.filter((post) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;

    const target = [
      post.content || "",
      post.author?.display_name || "",
      ...(post.attachments || []).map((attachment) => attachment.name || ""),
    ].join(" ").toLowerCase();

    return target.includes(query);
  });

  function loadPosts() {
    setLoading(true);
    const params = new URLSearchParams({
      group_id: id,
      limit: String(POSTS_PAGE_LIMIT),
    });
    fetch(`/api/posts?${params.toString()}`, { headers: getDeviceHeaders() })
      .then((res) => (res.ok ? res.json() : {
        posts: [],
        groupName: null,
        postingDisabled: false,
        postingDisabledMessage: null,
      }))
      .then((data) => {
        const loadedPosts = (data.posts || []) as Post[];
        setPosts(loadedPosts);
        setReadReceipts(data.readReceipts || []);
        setCommentsByPost(Object.fromEntries(
          loadedPosts
            .filter((post) => Array.isArray(post.commentPreview) && post.commentPreview.length > 0)
            .map((post) => [post.id, post.commentPreview || []]),
        ));
        setExpandedCommentsByPost({});
        setHasMorePosts(Boolean(data.hasMore));
        setPostingDisabled(Boolean(data.postingDisabled));
        setPostingDisabledMessage(data.postingDisabledMessage || "");
        if (data.groupName) setGroupName(data.groupName);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function loadMorePosts() {
    if (loadingMorePosts || loading || posts.length === 0 || !hasMorePosts) return;

    const oldestPost = posts[posts.length - 1];
    if (!oldestPost?.created_at) return;

    setLoadingMorePosts(true);
    try {
      const params = new URLSearchParams({
        group_id: id,
        limit: String(POSTS_PAGE_LIMIT),
        before: oldestPost.created_at,
      });
      const res = await fetch(`/api/posts?${params.toString()}`, { headers: getDeviceHeaders() });
      const data = res.ok ? await res.json() : { posts: [], hasMore: false };
      const nextPosts = (data.posts || []) as Post[];
      setReadReceipts(data.readReceipts || []);
      setCommentsByPost((current) => ({
        ...current,
        ...Object.fromEntries(
          nextPosts
            .filter((post) => Array.isArray(post.commentPreview) && post.commentPreview.length > 0)
            .map((post) => [post.id, post.commentPreview || []]),
        ),
      }));
      setPosts((current) => {
        const existingIds = new Set(current.map((post) => post.id));
        return sortBoardPosts([...current, ...nextPosts.filter((post) => !existingIds.has(post.id))]);
      });
      setHasMorePosts(Boolean(data.hasMore));
    } finally {
      setLoadingMorePosts(false);
    }
  }

  async function loadGroupMembers() {
    if (taskMembers.length > 0 || taskMembersLoading) return;

    setTaskMembersLoading(true);
    try {
      const res = await fetch(`/api/groups/${id}/members`);
      const data = res.ok ? await res.json() : { members: [] };
      setTaskMembers(sortTaskMembers(data.members || []));
    } catch {
      setTaskMembers([]);
    } finally {
      setTaskMembersLoading(false);
    }
  }

  async function uploadFile(file: File, uploadOriginalFile: boolean): Promise<Attachment[]> {
    const formData = new FormData();
    const preparedFile = await prepareUploadFile(file, uploadOriginalFile);
    formData.append("file", preparedFile);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || "ファイルのアップロードに失敗しました");
    }

    return [{
      type: data.type,
      url: data.viewUrl || data.url,
      name: data.name,
      driveId: data.driveId,
      viewUrl: data.viewUrl,
      webViewLink: data.webViewLink,
    }];
  }

  async function handlePost() {
    if (isPosting || isUploading || (!text.trim() && !selectedFile)) return;
    if (taskEnabled && taskAssigneeIds.length === 0) {
      alert("タスク担当者を選択してください");
      return;
    }
    if (taskEnabled && !taskDueDate) {
      alert("タスク期限を選択してください");
      return;
    }

    setIsPosting(true);
    setIsUploading(Boolean(selectedFile));
    try {
      const attachments = selectedFile ? await uploadFile(selectedFile, uploadOriginal) : [];
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: id,
          content: text.trim(),
          attachments,
          task: taskEnabled ? { assignee_ids: taskAssigneeIds, due_date: taskDueDate } : undefined,
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
      setTaskEnabled(false);
      setTaskAssigneeIds([]);
      setTaskDueDate("");
      setMentionPickerOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (textareaRef.current) textareaRef.current.style.height = "38px";

      if (data?.post) {
        setPosts((current) => sortBoardPosts([data.post, ...current]));
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
      setReadReceipts(data.readReceipts || []);
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
    setReplyTargetByPost((current) => ({ ...current, [postId]: null }));

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

  function openReplyComposer(postId: string, comment: Post) {
    setActiveCommentPostId(postId);
    setReplyTargetByPost((current) => ({ ...current, [postId]: comment }));

    if (!commentsByPost[postId]) {
      void loadComments(postId);
    }

    window.setTimeout(() => {
      commentSectionRefs.current[postId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      window.setTimeout(() => commentInputRefs.current[postId]?.focus(), 80);
    }, 0);
  }

  async function showAllComments(postId: string) {
    if (commentLoadingByPost[postId]) return;
    await loadComments(postId);
    setExpandedCommentsByPost((current) => ({ ...current, [postId]: true }));
  }

  async function handleComment(postId: string) {
    const content = (commentTextByPost[postId] || "").trim();
    const selectedCommentFile = commentFilesByPost[postId] || null;
    const uploadOriginalComment = commentUploadOriginalByPost[postId] || false;
    const replyTarget = replyTargetByPost[postId] || null;
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
          reply_to_id: replyTarget?.id || null,
          content,
          attachments,
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
      setReplyTargetByPost((current) => ({ ...current, [postId]: null }));
      setCommentMentionPickerPostId((current) => (current === postId ? null : current));
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

  function toggleMentionPicker() {
    setCommentMentionPickerPostId(null);
    setMentionPickerOpen((current) => {
      const next = !current;
      if (next) void loadGroupMembers();
      return next;
    });
  }

  function toggleCommentMentionPicker(postId: string) {
    setMentionPickerOpen(false);
    setCommentMentionPickerPostId((current) => {
      const next = current === postId ? null : postId;
      if (next) {
        setActiveCommentPostId(postId);
        void loadGroupMembers();
      }
      return next;
    });
  }

  function insertMention(member: GroupMember) {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? text.length;
    const needsLeadingSpace = start > 0 && !/\s/.test(text.charAt(start - 1));
    const mention = `${needsLeadingSpace ? " " : ""}@${formatMentionName(member.display_name)} `;
    const nextText = `${text.slice(0, start)}${mention}${text.slice(end)}`;
    const cursor = start + mention.length;

    setText(nextText);
    setMentionPickerOpen(false);

    window.setTimeout(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(cursor, cursor);
      textareaRef.current.style.height = "38px";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }, 0);
  }

  function insertDepartmentMention(department: UserDepartment) {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? text.length;
    const needsLeadingSpace = start > 0 && !/\s/.test(text.charAt(start - 1));
    const mention = `${needsLeadingSpace ? " " : ""}@${department} `;
    const nextText = `${text.slice(0, start)}${mention}${text.slice(end)}`;
    const cursor = start + mention.length;

    setText(nextText);
    setMentionPickerOpen(false);

    window.setTimeout(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(cursor, cursor);
      textareaRef.current.style.height = "38px";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }, 0);
  }

  function insertCommentMention(postId: string, member: GroupMember) {
    const input = commentInputRefs.current[postId];
    const currentText = commentTextByPost[postId] || "";
    const start = input?.selectionStart ?? currentText.length;
    const end = input?.selectionEnd ?? currentText.length;
    const needsLeadingSpace = start > 0 && !/\s/.test(currentText.charAt(start - 1));
    const mention = `${needsLeadingSpace ? " " : ""}@${formatMentionName(member.display_name)} `;
    const nextText = `${currentText.slice(0, start)}${mention}${currentText.slice(end)}`;
    const cursor = start + mention.length;

    setCommentTextByPost((current) => ({ ...current, [postId]: nextText }));
    setCommentMentionPickerPostId(null);
    setActiveCommentPostId(postId);

    window.setTimeout(() => {
      const target = commentInputRefs.current[postId];
      if (!target) return;
      target.focus();
      target.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function insertCommentDepartmentMention(postId: string, department: UserDepartment) {
    const input = commentInputRefs.current[postId];
    const currentText = commentTextByPost[postId] || "";
    const start = input?.selectionStart ?? currentText.length;
    const end = input?.selectionEnd ?? currentText.length;
    const needsLeadingSpace = start > 0 && !/\s/.test(currentText.charAt(start - 1));
    const mention = `${needsLeadingSpace ? " " : ""}@${department} `;
    const nextText = `${currentText.slice(0, start)}${mention}${currentText.slice(end)}`;
    const cursor = start + mention.length;

    setCommentTextByPost((current) => ({ ...current, [postId]: nextText }));
    setCommentMentionPickerPostId(null);
    setActiveCommentPostId(postId);

    window.setTimeout(() => {
      const target = commentInputRefs.current[postId];
      if (!target) return;
      target.focus();
      target.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    setUploadOriginal(false);
  }

  function attachPostFile(file: File | null) {
    setSelectedFile(file);
    setUploadOriginal(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handlePostPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;

    e.preventDefault();
    attachPostFile(file);
  }

  function handlePostDragEnter(e: React.DragEvent<HTMLElement>) {
    if (isPosting || isUploading || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    setPostDropActive(true);
  }

  function handlePostDragOver(e: React.DragEvent<HTMLElement>) {
    if (isPosting || isUploading || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handlePostDragLeave(e: React.DragEvent<HTMLElement>) {
    const nextTarget = e.relatedTarget as Node | null;
    if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
      setPostDropActive(false);
    }
  }

  function handlePostDrop(e: React.DragEvent<HTMLElement>) {
    if (isPosting || isUploading || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    const file = getFirstDroppedFile(e.dataTransfer);
    setPostDropActive(false);
    if (!file) return;
    attachPostFile(file);
    textareaRef.current?.focus();
  }

  function handleCommentFileChange(postId: string, file: File | null) {
    setCommentFilesByPost((current) => ({ ...current, [postId]: file }));
    setCommentUploadOriginalByPost((current) => ({ ...current, [postId]: false }));
  }

  function handleCommentPaste(postId: string, e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;

    e.preventDefault();
    attachCommentFile(postId, file);
  }

  function attachCommentFile(postId: string, file: File | null) {
    handleCommentFileChange(postId, file);
    if (commentFileInputRefs.current[postId]) {
      commentFileInputRefs.current[postId]!.value = "";
    }
  }

  function handleCommentDragEnter(postId: string, e: React.DragEvent<HTMLElement>) {
    if (commentSubmittingByPost[postId] || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setPostDropActive(false);
    setCommentDropActivePostId(postId);
  }

  function handleCommentDragOver(postId: string, e: React.DragEvent<HTMLElement>) {
    if (commentSubmittingByPost[postId] || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleCommentDragLeave(postId: string, e: React.DragEvent<HTMLElement>) {
    e.stopPropagation();
    const nextTarget = e.relatedTarget as Node | null;
    if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
      setCommentDropActivePostId((current) => (current === postId ? null : current));
    }
  }

  function handleCommentDrop(postId: string, e: React.DragEvent<HTMLElement>) {
    if (commentSubmittingByPost[postId] || !hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const file = getFirstDroppedFile(e.dataTransfer);
    setPostDropActive(false);
    setCommentDropActivePostId(null);
    if (!file) return;
    attachCommentFile(postId, file);
    commentInputRefs.current[postId]?.focus();
  }

  function canEditPost(post: Post) {
    if (postingDisabled) return false;
    return currentUser?.id === post.user_id || (isManagementRole(currentUser?.role) && Boolean(post.tasks?.length));
  }

  function canDeletePost(post: Post) {
    if (postingDisabled) return isManagementRole(currentUser?.role);
    return currentUser?.id === post.user_id || isManagementRole(currentUser?.role);
  }

  function canAnnotatePost(post: Post) {
    return !postingDisabled && canDeletePost(post);
  }

  function canPinPost(post: Post) {
    return isManagementRole(currentUser?.role) && !post.parent_id;
  }

  function toggleTaskAssignee(memberId: string) {
    setTaskAssigneeIds((current) => (
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId]
    ));
  }

  function toggleEditingTaskAssignee(memberId: string) {
    setEditingTaskAssigneeIds((current) => (
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId]
    ));
  }

  function toggleTaskRequestPanel() {
    const nextEnabled = !taskEnabled;
    setTaskEnabled(nextEnabled);
    setTaskAssigneeIds([]);
    if (!nextEnabled) setTaskDueDate("");
  }

  function startEditing(post: Post) {
    setEditingPostId(post.id);
    setEditingText(post.content || "");
    setEditingTaskAssigneeIds((post.tasks || []).map((task) => task.assignee_id));
    setEditingTaskDueDate(post.tasks?.[0]?.due_date || "");
    if (post.tasks?.length) void loadGroupMembers();
  }

  async function saveEdit(post: Post) {
    if (savingEdit) return;

    const isTaskEdit = Boolean(post.tasks?.length);
    if (isTaskEdit && editingTaskAssigneeIds.length === 0) {
      alert("タスク担当者を選択してください");
      return;
    }
    if (isTaskEdit && !editingTaskDueDate) {
      alert("タスク期限を選択してください");
      return;
    }

    setSavingEdit(true);
    try {
      const res = await fetch("/api/posts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post_id: post.id,
          content: editingText,
          task: isTaskEdit ? { assignee_ids: editingTaskAssigneeIds, due_date: editingTaskDueDate } : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error || "投稿の更新に失敗しました");
        return;
      }

      const data = await res.json();
      const nextContent = data.post.content;
      const nextTasks = Array.isArray(data.post.tasks) ? data.post.tasks : undefined;
      setPosts((current) => current.map((item) => (
        item.id === post.id ? { ...item, content: nextContent, ...(nextTasks ? { tasks: nextTasks } : {}) } : item
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
      setEditingTaskAssigneeIds([]);
      setEditingTaskDueDate("");
    } finally {
      setSavingEdit(false);
    }
  }

  async function saveAnnotatedImage(file: File) {
    if (!annotatingImage || annotationSaving) return;

    const target = annotatingImage;
    setAnnotationSaving(true);
    try {
      const [uploadedAttachment] = await uploadFile(file, true);
      const nextAttachments = target.post.attachments.map((attachment, index) => (
        index === target.attachmentIndex ? uploadedAttachment : attachment
      ));

      const res = await fetch("/api/posts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attachments",
          post_id: target.post.id,
          attachments: nextAttachments,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || "画像の保存に失敗しました");
      }

      const updatedAttachments = Array.isArray(data?.post?.attachments) ? data.post.attachments : nextAttachments;
      setPosts((current) => current.map((item) => (
        item.id === target.post.id ? { ...item, attachments: updatedAttachments } : item
      )));
      setCommentsByPost((current) => {
        const next = { ...current };
        for (const postId of Object.keys(next)) {
          next[postId] = next[postId].map((item) => (
            item.id === target.post.id ? { ...item, attachments: updatedAttachments } : item
          ));
        }
        return next;
      });
      setAnnotatingImage(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : "画像の保存に失敗しました");
    } finally {
      setAnnotationSaving(false);
    }
  }

  async function togglePinPost(post: Post) {
    if (!canPinPost(post) || pinTogglingByPost[post.id]) return;

    const nextPinned = !post.is_pinned;
    setPinTogglingByPost((current) => ({ ...current, [post.id]: true }));
    try {
      const res = await fetch("/api/posts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pin",
          post_id: post.id,
          is_pinned: nextPinned,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error || "固定状態の更新に失敗しました");
        return;
      }

      setPosts((current) => sortBoardPosts(current.map((item) => (
        item.id === post.id ? { ...item, is_pinned: nextPinned } : item
      ))));
      if (!nextPinned) {
        setExpandedPinnedPosts((current) => {
          const next = { ...current };
          delete next[post.id];
          return next;
        });
      }
    } finally {
      setPinTogglingByPost((current) => ({ ...current, [post.id]: false }));
    }
  }

  function togglePinnedPostBody(postId: string) {
    setExpandedPinnedPosts((current) => ({ ...current, [postId]: !current[postId] }));
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

  function renderPinnedExpandButton(post: Post, isExpanded: boolean) {
    if (!post.is_pinned) return null;

    return (
      <button
        type="button"
        className="post-card__expand-btn"
        onClick={() => togglePinnedPostBody(post.id)}
        aria-expanded={isExpanded}
      >
        {isExpanded ? "折りたたむ" : "全文を表示"}
      </button>
    );
  }

  function renderPostBody(post: Post, isPinnedExpanded = true) {
    if (editingPostId === post.id) {
      const isTaskEdit = Boolean(post.tasks?.length);
      return (
        <div className="post-card__edit">
          <textarea
            className="post-card__edit-textarea"
            value={editingText}
            onChange={(e) => setEditingText(e.target.value)}
            rows={3}
            aria-label="投稿を編集"
          />
          {isTaskEdit && (
            <div className="task-request-panel task-request-panel--edit">
              <div className="task-request-panel__row">
                <label className="task-request-panel__date">
                  <span>期限</span>
                  <input
                    type="date"
                    value={editingTaskDueDate}
                    onChange={(event) => setEditingTaskDueDate(event.target.value)}
                    disabled={savingEdit}
                  />
                </label>
                <span className="task-request-panel__hint">担当者を編集できます</span>
              </div>
              <div className="task-request-members" aria-label="タスク担当者を編集">
                {taskMembersLoading ? (
                  <span className="task-request-members__empty">メンバーを読み込み中...</span>
                ) : taskMembers.length === 0 ? (
                  <span className="task-request-members__empty">選択できるメンバーがいません</span>
                ) : (
                  taskMembers.map((member) => {
                    const selected = editingTaskAssigneeIds.includes(member.id);
                    const currentTask = (post.tasks || []).find((task) => task.assignee_id === member.id);
                    return (
                      <button
                        key={member.id}
                        type="button"
                        className={`task-member-chip${selected ? " task-member-chip--selected" : ""}`}
                        onClick={() => toggleEditingTaskAssignee(member.id)}
                        disabled={savingEdit}
                        aria-pressed={selected}
                      >
                        {member.display_name}
                        {currentTask?.completed_at && <span>完了済</span>}
                        {memberPermissionLabel(member) && <span>{memberPermissionLabel(member)}</span>}
                        {member.isSelf && <span>自分</span>}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
          <div className="post-card__edit-actions">
            <button type="button" className="post-card__edit-btn" onClick={() => saveEdit(post)} disabled={savingEdit}>
              {savingEdit ? "保存中..." : "保存"}
            </button>
            <button
              type="button"
              className="post-card__edit-btn post-card__edit-btn--sub"
              onClick={() => {
                setEditingPostId(null);
                setEditingText("");
                setEditingTaskAssigneeIds([]);
                setEditingTaskDueDate("");
              }}
              disabled={savingEdit}
            >
              キャンセル
            </button>
          </div>
        </div>
      );
    }

    if (!post.content) {
      if (!post.is_pinned || isPinnedExpanded || !post.attachments?.length) return null;

      return (
        <>
          <button
            type="button"
            className="post-card__body post-card__body--pinned-collapsed post-card__body--attachment-preview"
            onClick={() => togglePinnedPostBody(post.id)}
            aria-expanded="false"
          >
            添付ファイル {post.attachments.length}件
          </button>
          {renderPinnedExpandButton(post, false)}
        </>
      );
    }

    return (
      <>
        <div
          className={`post-card__body${post.is_pinned && !isPinnedExpanded ? " post-card__body--pinned-collapsed" : ""}`}
          style={{ whiteSpace: "pre-wrap" }}
          role={post.is_pinned && !isPinnedExpanded ? "button" : undefined}
          tabIndex={post.is_pinned && !isPinnedExpanded ? 0 : undefined}
          aria-expanded={post.is_pinned ? isPinnedExpanded : undefined}
          onClick={post.is_pinned && !isPinnedExpanded ? () => togglePinnedPostBody(post.id) : undefined}
          onKeyDown={post.is_pinned && !isPinnedExpanded ? (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            togglePinnedPostBody(post.id);
          } : undefined}
        >
          {linkifyText(post.content)}
        </div>
        {isPinnedExpanded && <OgpPreviews text={post.content} />}
        {renderPinnedExpandButton(post, isPinnedExpanded)}
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
              <div key={`${attachment.name}-${index}`} className="post-card__image-shell">
                <button
                  type="button"
                className="post-card__image-button"
                onClick={() => setPreviewImage({ url: imageUrl, name: attachment.name })}
                aria-label={`${attachment.name}を拡大表示`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt={attachment.name} className="post-card__image" />
              </button>
                {canAnnotatePost(post) && (
                  <button
                    type="button"
                    className="post-card__annotate-btn"
                    onClick={() => setAnnotatingImage({ post, attachment, attachmentIndex: index })}
                    aria-label="画像に赤丸・赤枠を追加"
                  >
                    赤丸/赤枠
                  </button>
                )}
              </div>
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

  function renderTaskSummary(post: Post) {
    const tasks = post.tasks || [];
    if (tasks.length === 0) return null;

    const completedCount = tasks.filter(task => task.completed_at).length;
    const allCompleted = completedCount === tasks.length;
    const dueLabel = tasks[0]?.due_date ? formatDueDate(tasks[0].due_date) : "";

    return (
      <section className={`post-task-box${allCompleted ? " post-task-box--completed" : ""}`} aria-label="タスク依頼">
        <div className="post-task-box__header">
          <span className="post-task-badge">タスク依頼</span>
          <span className="post-task-box__meta">
            {dueLabel && <>期限 {dueLabel} ・ </>}
            {completedCount}/{tasks.length} 完了
          </span>
        </div>
        <div className="post-task-box__list">
          {tasks.map((task) => (
            <div key={task.id} className="post-task-box__assignee">
              <span className="post-task-box__dot" aria-hidden="true">{task.completed_at ? "✓" : ""}</span>
              <span className="post-task-box__name">{task.assignee?.display_name || "不明"}</span>
              <span className="post-task-box__status">
                {task.completed_at ? "完了" : "未完了"}
              </span>
            </div>
          ))}
        </div>
        {allCompleted && (
          <div className="post-task-box__done">このタスク依頼は完了しました</div>
        )}
      </section>
    );
  }

  function renderComment(post: Post, parentPostId: string) {
    const readers = currentUser?.id === post.user_id
      ? readReceipts.filter(receipt => new Date(receipt.last_read_at) >= new Date(post.created_at))
      : [];

    return (
      <article
        key={post.id}
        id={`comment-${post.id}`}
        className={`post-comment${post.reply_to_id ? " post-comment--reply" : ""}`}
      >
        <Avatar user={post.author} size={28} />
        <div className="post-comment__main">
          <div className="post-comment__meta">
            <span>{post.author.display_name}</span>
            <span>{formatDate(post.created_at)}</span>
          </div>
          {post.reply_to && (
            <div className="post-comment__reply-context">
              {post.reply_to.display_name}さんへの返信
            </div>
          )}
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
          {readers.length > 0 && (
            <div className="post-comment__read-row">
              <ReadReceiptAvatars readers={readers} />
            </div>
          )}
          <div className="post-comment__actions">
            {!postingDisabled && (
              <button type="button" onClick={() => openReplyComposer(parentPostId, post)}>
                返信
              </button>
            )}
            {(canEditPost(post) || canDeletePost(post)) && (
              <>
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
              </>
            )}
          </div>
        </div>
      </article>
    );
  }

  function renderCommentComposer(post: Post) {
    const commentFile = commentFilesByPost[post.id] || null;
    const uploadOriginalComment = commentUploadOriginalByPost[post.id] || false;
    const isCommentSubmitting = commentSubmittingByPost[post.id] || false;
    const currentCommentText = commentTextByPost[post.id] || "";
    const replyTarget = replyTargetByPost[post.id] || null;

    return (
      <div
        className={`comment-composer-drop-zone${commentDropActivePostId === post.id ? " comment-composer-drop-zone--drop-active" : ""}`}
        onDragEnter={(event) => handleCommentDragEnter(post.id, event)}
        onDragOver={(event) => handleCommentDragOver(post.id, event)}
        onDragLeave={(event) => handleCommentDragLeave(post.id, event)}
        onDrop={(event) => handleCommentDrop(post.id, event)}
      >
        {commentDropActivePostId === post.id && (
          <div className="comment-file-drop-indicator" aria-hidden="true">
            <span>ファイルをドロップして添付</span>
          </div>
        )}
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

        {replyTarget && (
          <div className="comment-reply-target">
            <span>{replyTarget.author.display_name}さんへ返信</span>
            <button
              type="button"
              onClick={() => setReplyTargetByPost((current) => ({ ...current, [post.id]: null }))}
              disabled={isCommentSubmitting}
              aria-label="返信先を解除"
            >
              ×
            </button>
          </div>
        )}

        {commentMentionPickerPostId === post.id && (
          <div className="mention-picker mention-picker--comment" role="listbox" aria-label="comment mention candidates">
            {taskMembersLoading ? (
              <span className="mention-picker__empty">Loading members...</span>
            ) : taskMembers.length === 0 ? (
              <span className="mention-picker__empty">No mentionable members</span>
            ) : (
              <>
                {USER_DEPARTMENTS.map((department) => (
                  <button
                    key={`department-${department}`}
                    type="button"
                    className="mention-chip"
                    onClick={() => insertCommentDepartmentMention(post.id, department)}
                    disabled={isCommentSubmitting}
                    role="option"
                    aria-selected="false"
                  >
                    <span>@{department}</span>
                    <small>部署</small>
                  </button>
                ))}
                {taskMembers.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className="mention-chip"
                    onClick={() => insertCommentMention(post.id, member)}
                    disabled={isCommentSubmitting}
                    role="option"
                    aria-selected="false"
                  >
                    <Avatar user={member} size={24} />
                    <span>{mentionDisplayName(member.display_name)}</span>
                    {isAdminMember(member) && <small>admin</small>}
                  </button>
                ))}
              </>
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
          <button
            type="button"
            className={`mention-toggle-btn mention-toggle-btn--comment${commentMentionPickerPostId === post.id ? " mention-toggle-btn--active" : ""}`}
            aria-label="show comment mention candidates"
            aria-pressed={commentMentionPickerPostId === post.id}
            onClick={() => toggleCommentMentionPicker(post.id)}
            disabled={isCommentSubmitting}
          >
            @
          </button>
          <textarea
            ref={(element) => {
              commentInputRefs.current[post.id] = element;
            }}
            value={currentCommentText}
            onChange={(e) => setCommentTextByPost((current) => ({ ...current, [post.id]: e.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                handleComment(post.id);
              }
            }}
            onPaste={(e) => handleCommentPaste(post.id, e)}
            rows={1}
            placeholder="コメントを入力..."
            aria-label="コメントを入力"
            disabled={isCommentSubmitting}
          />
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
      </div>
    );
  }

  function renderPost(post: Post) {
    const comments = commentsByPost[post.id] || [];
    const isComposerActive = activeCommentPostId === post.id;
    const isCommentLoading = commentLoadingByPost[post.id] || false;
    const commentsExpanded = expandedCommentsByPost[post.id] === true;
    const visibleComments = commentsExpanded ? comments : comments.slice(-COMMENT_PREVIEW_LIMIT);
    const hiddenCommentCount = Math.max(0, post.commentCount - visibleComments.length);
    const showCommentsSection = post.commentCount > 0 || (!postingDisabled && isComposerActive);
    const isPinnedExpanded = !post.is_pinned || expandedPinnedPosts[post.id] === true;
    const readers = currentUser?.id === post.user_id
      ? readReceipts.filter(receipt => new Date(receipt.last_read_at) >= new Date(post.created_at))
      : [];

    return (
      <article
        key={post.id}
        id={`post-${post.id}`}
        className={`post-card${post.tasks?.length ? " post-card--task" : ""}${post.is_pinned ? " post-card--pinned" : ""}${post.is_pinned && !isPinnedExpanded ? " post-card--pinned-collapsed" : ""}`}
      >
        {post.is_pinned && (
          <div className="post-card__pinned">
            📌 ピン留め
          </div>
        )}

        <header className="post-card__header">
          <Avatar user={post.author} size={40} />
          <div className="post-card__user-info">
            <div className="post-card__username">{post.author.display_name}</div>
            <div className="post-card__time">
              {formatDate(post.created_at)}
              {!!post.tasks?.length && <span className="post-task-inline-badge">タスク依頼</span>}
            </div>
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
            {canPinPost(post) && (
              <button
                type="button"
                className="post-card__action-btn"
                onClick={() => togglePinPost(post)}
                disabled={pinTogglingByPost[post.id]}
              >
                {post.is_pinned ? "固定解除" : "固定"}
              </button>
            )}
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

        {renderTaskSummary(post)}
        {renderPostBody(post, isPinnedExpanded)}
        {isPinnedExpanded && renderAttachments(post)}

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

        {readers.length > 0 && (
          <div className="post-card__read-row">
            <ReadReceiptAvatars readers={readers} />
          </div>
        )}

        <div className="post-comments-details">
          <div className="post-card__footer post-comments-summary-inline">
            <span className="post-card__footer-btn">
              💬 {post.commentCount}件のコメント
            </span>
            {!postingDisabled && (
              <button type="button" className="post-card__footer-btn" onClick={() => openCommentComposer(post.id)}>
                コメントする
              </button>
            )}
          </div>
          {showCommentsSection && (
            <section
              className="post-comments"
              aria-label="コメント"
              ref={(element) => {
                commentSectionRefs.current[post.id] = element;
              }}
            >
              {visibleComments.map((comment) => renderComment(comment, post.id))}
              {!commentsExpanded && post.commentCount > COMMENT_PREVIEW_LIMIT && (
                <button
                  type="button"
                  className="post-comments__more"
                  onClick={() => void showAllComments(post.id)}
                  disabled={isCommentLoading}
                >
                  {isCommentLoading ? "コメントを読み込み中..." : `さらに${hiddenCommentCount}件のコメントを表示`}
                </button>
              )}
              {post.commentCount > 0 && visibleComments.length === 0 && (
                <p className="post-comments__empty">コメントを読み込み中...</p>
              )}
              {!postingDisabled && isComposerActive && renderCommentComposer(post)}
            </section>
          )}
        </div>
      </article>
    );
  }

  function renderLoadMorePosts() {
    if (!hasMorePosts) return null;

    return (
      <div className="post-list__load-more">
        <button
          type="button"
          className="post-load-more-btn"
          onClick={loadMorePosts}
          disabled={loadingMorePosts}
        >
          {loadingMorePosts ? "読み込み中..." : "過去投稿を読み込む"}
        </button>
      </div>
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
    <div
      className={`board-page${postDropActive ? " board-page--drop-active" : ""}`}
      onDragEnter={postingDisabled ? undefined : handlePostDragEnter}
      onDragOver={postingDisabled ? undefined : handlePostDragOver}
      onDragLeave={postingDisabled ? undefined : handlePostDragLeave}
      onDrop={postingDisabled ? undefined : handlePostDrop}
    >
      {postDropActive && (
        <div className="page-file-drop-indicator" aria-hidden="true">
          <span>ファイルをドロップして添付</span>
        </div>
      )}
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

      <div className="thread-search thread-search--board" role="search">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="掲示板を検索"
          aria-label="掲示板を検索"
        />
        {searchQuery && (
          <button type="button" onClick={() => setSearchQuery("")} aria-label="検索をクリア">
            クリア
          </button>
        )}
      </div>

      <section className="post-list" aria-label="投稿一覧">
        {loading ? (
          <p className="post-list__state">読み込み中...</p>
        ) : posts.length === 0 ? (
          <p className="post-list__state">
            {postingDisabled ? "保存されている投稿はありません。" : "投稿がありません。最初の投稿をしてみましょう。"}
          </p>
        ) : filteredPosts.length === 0 ? (
          <>
            <p className="post-list__state">検索条件に一致する投稿はありません。</p>
            {renderLoadMorePosts()}
          </>
        ) : (
          <>
            {filteredPosts.map(renderPost)}
            {renderLoadMorePosts()}
          </>
        )}
      </section>

      {!loading && (postingDisabled ? (
        <footer className="board-footer board-footer--read-only">
          <div className="board-read-only" role="status">
            <div>
              <strong>閲覧専用</strong>
              <span>{postingDisabledMessage || "この掲示板への投稿・コメントは終了しました。"}</span>
            </div>
            <button type="button" className="btn-primary" onClick={() => router.push("/leave")}>
              有給申請を開く
            </button>
          </div>
        </footer>
      ) : (
      <footer className="board-footer">
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

        {taskEnabled && (
          <div className="task-request-panel">
            <div className="task-request-panel__row">
              <label className="task-request-panel__date">
                <span>期限</span>
                <input
                  type="date"
                  value={taskDueDate}
                  onChange={(event) => setTaskDueDate(event.target.value)}
                  disabled={isPosting || isUploading}
                />
              </label>
              <span className="task-request-panel__hint">担当者は複数選択できます</span>
            </div>
            <div className="task-request-members" aria-label="タスク担当者">
              {taskMembersLoading ? (
                <span className="task-request-members__empty">メンバーを読み込み中...</span>
              ) : taskMembers.length === 0 ? (
                <span className="task-request-members__empty">選択できるメンバーがいません</span>
              ) : (
                taskMembers.map((member) => {
                  const selected = taskAssigneeIds.includes(member.id);
                  return (
                    <button
                      key={member.id}
                      type="button"
                      className={`task-member-chip${selected ? " task-member-chip--selected" : ""}`}
                      onClick={() => toggleTaskAssignee(member.id)}
                      disabled={isPosting || isUploading}
                      aria-pressed={selected}
                    >
                      {member.display_name}
                      {memberPermissionLabel(member) && <span>{memberPermissionLabel(member)}</span>}
                      {member.isSelf && <span>自分</span>}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {mentionPickerOpen && (
          <div className="mention-picker" role="listbox" aria-label="メンション候補">
            {taskMembersLoading ? (
              <span className="mention-picker__empty">メンバー読込中...</span>
            ) : taskMembers.length === 0 ? (
              <span className="mention-picker__empty">メンションできるメンバーがいません</span>
            ) : (
              <>
                {USER_DEPARTMENTS.map((department) => (
                  <button
                    key={`department-${department}`}
                    type="button"
                    className="mention-chip"
                    onClick={() => insertDepartmentMention(department)}
                    disabled={isPosting || isUploading}
                    role="option"
                    aria-selected="false"
                  >
                    <span>@{department}</span>
                    <small>部署</small>
                  </button>
                ))}
                {taskMembers.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className="mention-chip"
                  onClick={() => insertMention(member)}
                  disabled={isPosting || isUploading}
                  role="option"
                  aria-selected="false"
                >
                  <Avatar user={member} size={24} />
                  <span>{mentionDisplayName(member.display_name)}</span>
                  {memberPermissionLabel(member) && <small>{memberPermissionLabel(member)}</small>}
                </button>
                ))}
              </>
            )}
          </div>
        )}

        <form className="post-input-bar__form" onSubmit={(e) => { e.preventDefault(); handlePost(); }} aria-label="新規投稿">
          <button
            type="button"
            className={`mention-toggle-btn${mentionPickerOpen ? " mention-toggle-btn--active" : ""}`}
            aria-label="メンション候補を表示"
            aria-pressed={mentionPickerOpen}
            onClick={toggleMentionPicker}
            disabled={isPosting || isUploading}
          >
            @
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={autoResize}
            onKeyDown={handleKeyDown}
            onPaste={handlePostPaste}
            placeholder="投稿内容を入力... (Ctrl+Enterで送信)"
            rows={1}
            aria-label="投稿テキスト"
            disabled={isPosting || isUploading}
          />
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
            type="button"
            className={`task-toggle-btn${taskEnabled ? " task-toggle-btn--active" : ""}`}
            onClick={toggleTaskRequestPanel}
            disabled={isPosting || isUploading}
            aria-pressed={taskEnabled}
          >
            タスク依頼
          </button>
          <button
            type="submit"
            className="send-btn"
            aria-label="投稿を送信"
            disabled={isPosting || isUploading || (!text.trim() && !selectedFile) || (taskEnabled && (!taskDueDate || taskAssigneeIds.length === 0))}
          >
            {isPosting || isUploading ? "..." : "↑"}
          </button>
        </form>
        </div>
      </footer>
      ))}

      {annotatingImage && (
        <ImageAnnotationEditor
          imageUrl={getAttachmentImageUrl(annotatingImage.attachment)}
          imageName={annotatingImage.attachment.name || "image"}
          saving={annotationSaving}
          onCancel={() => {
            if (!annotationSaving) setAnnotatingImage(null);
          }}
          onSave={saveAnnotatedImage}
        />
      )}

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
