"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, FileCheck2 } from "lucide-react";
import { pledgeReminderInfo } from "@/lib/pledge-reminders";

type PledgeItem = { id: string; text: string };
type Assignment = {
  id: string;
  status: "pending" | "processing" | "submitted";
  pledged_at: string | null;
  dm_group_id: string | null;
  delivery: {
    title_snapshot: string;
    body_snapshot: string;
    check_items_snapshot: PledgeItem[];
    agreement_label_snapshot: string;
    company_name_snapshot: string;
    is_test: boolean;
    sent_at: string;
  };
};

export default function PledgePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`/api/pledges?assignment_id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "誓約書を読み込めませんでした");
        setAssignment(data.assignments?.[0] || null);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "誓約書を読み込めませんでした"))
      .finally(() => setLoading(false));
  }, [id]);

  const items = useMemo(() => Array.isArray(assignment?.delivery.check_items_snapshot) ? assignment!.delivery.check_items_snapshot : [], [assignment]);
  const bodySections = useMemo(() => {
    const text = assignment?.delivery.body_snapshot || "";
    const markerIndex = text.indexOf("【重要】");
    if (markerIndex < 0) return { introduction: text, important: "" };
    return {
      introduction: text.slice(0, markerIndex).trim(),
      important: text.slice(markerIndex).trim(),
    };
  }, [assignment?.delivery.body_snapshot]);
  const reminder = useMemo(
    () => assignment ? pledgeReminderInfo(assignment.delivery.sent_at, assignment.delivery.is_test) : null,
    [assignment],
  );
  const allChecked = items.length > 0 && items.every((item) => checkedIds.has(item.id));

  function toggleItem(itemId: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function submit() {
    if (!assignment || !allChecked || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/pledges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignment.id, accepted_item_ids: [...checkedIds] }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "誓約書を送信できませんでした");
      setAssignment((current) => current ? { ...current, status: "submitted", pledged_at: new Date().toISOString(), dm_group_id: data.dm_group_id || current.dm_group_id } : current);
      setMessage("誓約書を提出し、PDFをあなたのDMへ送信しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "誓約書を送信できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pledge-page">
      <header className="top-header pledge-page__header">
        <button type="button" className="top-header__back" onClick={() => router.push("/groups")} aria-label="戻る">‹</button>
        <h1 className="top-header__title">誓約書</h1>
        <span className="top-header__meta">{assignment?.delivery.is_test ? "テスト" : ""}</span>
      </header>

      <main className="pledge-document page-content">
        {loading && <p className="pledge-document__state">読み込み中...</p>}
        {!loading && !assignment && <p className="pledge-document__state">{message || "誓約書が見つかりません"}</p>}
        {assignment && (
          <>
            <div className="pledge-document__title-icon"><FileCheck2 size={28} aria-hidden="true" /></div>
            <h2>{assignment.delivery.title_snapshot}</h2>
            <div className="pledge-document__company">{assignment.delivery.company_name_snapshot}</div>
            {assignment.status !== "submitted" && reminder && reminder.level !== "pending" && (
              <div className={`pledge-document__deadline pledge-document__deadline--${reminder.level}`}>
                <strong>{reminder.headline}</strong>
                <span>{reminder.detail}</span>
              </div>
            )}
            <div className="pledge-document__body">
              {bodySections.introduction.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => {
                return <p key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>;
              })}
            </div>

            <div className="pledge-document__checks">
              {items.map((item) => {
                const checked = checkedIds.has(item.id) || assignment.status === "submitted";
                return (
                  <button key={item.id} type="button" className={checked ? "pledge-check pledge-check--checked" : "pledge-check"} onClick={() => assignment.status === "pending" && toggleItem(item.id)} disabled={assignment.status !== "pending"}>
                    <span className="pledge-check__box">{checked && <Check size={18} aria-hidden="true" />}</span>
                    <span className="pledge-check__text">{item.text}</span>
                  </button>
                );
              })}
            </div>

            {bodySections.important && (
              <div className="pledge-document__body pledge-document__important-block">
                {bodySections.important.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => (
                  <p key={`${index}:${paragraph.slice(0, 12)}`} className={paragraph.trim() === "【重要】" ? "pledge-document__important-heading" : ""}>{paragraph}</p>
                ))}
              </div>
            )}

            {message && <div className="pledge-document__message">{message}</div>}
            {assignment.status === "submitted" ? (
              <div className="pledge-document__completed">
                <strong>誓約済み</strong>
                {assignment.pledged_at && <span>{new Date(assignment.pledged_at).toLocaleString("ja-JP")}</span>}
                {assignment.dm_group_id && <Link href={`/chat/${assignment.dm_group_id}`}>PDFをDMで確認</Link>}
                <Link href="/groups">ホームへ戻る</Link>
              </div>
            ) : (
              <button type="button" className="pledge-submit-btn" disabled={!allChecked || submitting || assignment.status !== "pending"} onClick={submit}>
                {submitting ? "PDFを作成・送信中..." : assignment.delivery.agreement_label_snapshot}
              </button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
