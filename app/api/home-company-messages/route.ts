import { NextRequest, NextResponse } from "next/server";
import { getUserSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";
import { hasFeatureRole } from "@/lib/management-permissions";
import { normalizeUserName } from "@/lib/user-roles";

type MessageAttachment = {
  url: string;
  viewUrl?: string;
  webViewLink?: string;
  name: string;
  type: string;
  driveId?: string;
};

type CompanyMessageRow = {
  id: string;
  author_user_id: string;
  title: string | null;
  body: string;
  attachment: unknown;
  created_at: string;
};

function cleanId(value: unknown) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "";
}

function cleanAttachment(value: unknown): MessageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const type = typeof input.type === "string" ? input.type.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 255) : "";
  if (!url || !name || !type.startsWith("image/")) return null;

  return {
    url,
    name,
    type,
    viewUrl: typeof input.viewUrl === "string" ? input.viewUrl.trim() : undefined,
    webViewLink: typeof input.webViewLink === "string" ? input.webViewLink.trim() : undefined,
    driveId: typeof input.driveId === "string" ? input.driveId.trim() : undefined,
  };
}

async function canCreateCompanyMessage(user: { id?: string | null }) {
  return hasFeatureRole(user, "home_company_message", "author");
}

function fallbackTitle(title: string | null, body: string) {
  const savedTitle = title?.trim();
  if (savedTitle) return savedTitle;
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 80) || "全社員メッセージ";
}

async function enrichMessages(messages: CompanyMessageRow[]) {
  const authorIds = [...new Set(messages.map((item) => item.author_user_id))];
  const { data: authors, error: authorError } = authorIds.length > 0
    ? await adminClient
      .from("gw_users")
      .select("id, display_name, real_name")
      .in("id", authorIds)
    : { data: [], error: null };

  if (authorError) throw authorError;
  const authorNames = new Map((authors || []).map((author) => [
    author.id,
    author.real_name || author.display_name || "社長",
  ]));

  return messages.map((message) => ({
    ...message,
    title: fallbackTitle(message.title, message.body),
    author_name: authorNames.get(message.author_user_id) || "社長",
  }));
}

export async function GET(request: NextRequest) {
  const user = await getUserSession();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  try {
    const canCreate = await canCreateCompanyMessage(user);
    if (request.nextUrl.searchParams.get("view") === "history") {
      const { data: messages, error: messageError } = await adminClient
        .from("gw_home_company_messages")
        .select("id, author_user_id, title, body, attachment, created_at")
        .order("created_at", { ascending: false });

      if (messageError) throw messageError;
      return NextResponse.json({
        messages: await enrichMessages((messages || []) as CompanyMessageRow[]),
        canCreate,
      });
    }

    const { data: recipients, error: recipientError } = await adminClient
      .from("gw_home_company_message_recipients")
      .select("message_id, created_at")
      .eq("user_id", user.id)
      .is("dismissed_at", null)
      .order("created_at", { ascending: false })
      .limit(20);

    if (recipientError) throw recipientError;
    const messageIds = (recipients || []).map((item) => item.message_id);
    if (messageIds.length === 0) {
      return NextResponse.json({ messages: [], canCreate });
    }

    const { data: messages, error: messageError } = await adminClient
      .from("gw_home_company_messages")
      .select("id, author_user_id, title, body, attachment, created_at")
      .in("id", messageIds);

    if (messageError) throw messageError;
    const enrichedMessages = await enrichMessages((messages || []) as CompanyMessageRow[]);
    const byId = new Map(enrichedMessages.map((message) => [message.id, message]));

    const orderedMessages = messageIds.flatMap((id) => {
      const message = byId.get(id);
      if (!message) return [];
      return [message];
    });

    return NextResponse.json({ messages: orderedMessages, canCreate });
  } catch (error) {
    console.error("home company message GET failed", error);
    return NextResponse.json({ error: "全社員メッセージを取得できませんでした" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  if (!(await canCreateCompanyMessage(user))) {
    return NextResponse.json({ error: "全社員メッセージを送信できるのは佐藤正彦さんだけです" }, { status: 403 });
  }

  const input = await request.json().catch(() => ({}));
  const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const attachment = cleanAttachment(input.attachment);
  if (!rawTitle) return NextResponse.json({ error: "タイトルを入力してください" }, { status: 400 });
  if (rawTitle.length > 80) return NextResponse.json({ error: "タイトルは80文字以内にしてください" }, { status: 400 });
  if (!body) return NextResponse.json({ error: "メッセージを入力してください" }, { status: 400 });
  if (body.length > 5000) return NextResponse.json({ error: "メッセージは5000文字以内にしてください" }, { status: 400 });
  if (input.attachment && !attachment) {
    return NextResponse.json({ error: "画像添付を確認してください" }, { status: 400 });
  }

  let createdMessageId = "";
  try {
    const { data: employees, error: employeeError } = await adminClient
      .from("gw_payroll_employees")
      .select("user_id")
      .eq("payroll_status", "active")
      .not("user_id", "is", null);

    if (employeeError) throw employeeError;
    const candidateIds = [...new Set((employees || []).map((item) => item.user_id).filter(Boolean))] as string[];
    if (candidateIds.length === 0) {
      return NextResponse.json({ error: "送信対象の在籍社員がいません" }, { status: 409 });
    }

    const { data: approvedUsers, error: userError } = await adminClient
      .from("gw_users")
      .select("id, display_name, real_name")
      .in("id", candidateIds)
      .eq("status", "approved");

    if (userError) throw userError;
    const recipientIds = (approvedUsers || [])
      .filter((item) => normalizeUserName(item.real_name || item.display_name) !== "TSG君")
      .map((item) => item.id);
    if (!recipientIds.includes(user.id)) recipientIds.push(user.id);

    const { data: message, error: messageError } = await adminClient
      .from("gw_home_company_messages")
      .insert({
        author_user_id: user.id,
        title: rawTitle,
        body,
        attachment,
      })
      .select("id, author_user_id, title, body, attachment, created_at")
      .single();

    if (messageError) throw messageError;
    createdMessageId = message.id;

    const { error: recipientError } = await adminClient
      .from("gw_home_company_message_recipients")
      .insert(recipientIds.map((userId) => ({ message_id: message.id, user_id: userId })));

    if (recipientError) throw recipientError;

    return NextResponse.json({
      message: { ...message, author_name: user.real_name || user.display_name || "社長" },
      recipient_count: recipientIds.length,
    });
  } catch (error) {
    if (createdMessageId) {
      await adminClient.from("gw_home_company_messages").delete().eq("id", createdMessageId);
    }
    console.error("home company message POST failed", error);
    return NextResponse.json({ error: "全社員メッセージを送信できませんでした" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getUserSession();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const input = await request.json().catch(() => ({}));
  const messageId = cleanId(input.message_id);
  if (!messageId) return NextResponse.json({ error: "メッセージを確認してください" }, { status: 400 });

  try {
    const { data, error } = await adminClient
      .from("gw_home_company_message_recipients")
      .update({ dismissed_at: new Date().toISOString() })
      .eq("message_id", messageId)
      .eq("user_id", user.id)
      .is("dismissed_at", null)
      .select("message_id")
      .maybeSingle();

    if (error) throw error;
    return NextResponse.json({ success: true, dismissed: Boolean(data) });
  } catch (error) {
    console.error("home company message DELETE failed", error);
    return NextResponse.json({ error: "メッセージを非表示にできませんでした" }, { status: 500 });
  }
}
