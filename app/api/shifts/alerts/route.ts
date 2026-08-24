import { NextRequest, NextResponse } from "next/server";
import { getUserSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";

function cleanId(value: unknown) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "";
}

export async function GET() {
  const user = await getUserSession();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  try {
    const { data, error } = await adminClient
      .from("gw_shift_confirmation_alerts")
      .select("id, period_id, department, period_title, start_date, end_date, created_at")
      .eq("user_id", user.id)
      .is("seen_at", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;
    return NextResponse.json({ alerts: data || [] });
  } catch (error) {
    console.error("shift confirmation alert GET failed", error);
    return NextResponse.json({ error: "シフト確定通知を取得できませんでした" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession();
  if (!user) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const alertId = cleanId(body.alert_id);
  if (!alertId) return NextResponse.json({ error: "通知を確認してください" }, { status: 400 });

  try {
    const { data, error } = await adminClient
      .from("gw_shift_confirmation_alerts")
      .update({ seen_at: new Date().toISOString() })
      .eq("id", alertId)
      .eq("user_id", user.id)
      .is("seen_at", null)
      .select("id, period_id")
      .maybeSingle();

    if (error) throw error;
    return NextResponse.json({
      success: true,
      acknowledged: Boolean(data),
      period_id: data?.period_id || null,
    });
  } catch (error) {
    console.error("shift confirmation alert POST failed", error);
    return NextResponse.json({ error: "シフト確定通知を更新できませんでした" }, { status: 500 });
  }
}
