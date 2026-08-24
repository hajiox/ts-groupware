"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

type CheckItem = { id: string; text: string };
type PaperDelivery = {
  id: string;
  title_snapshot: string;
  body_snapshot: string;
  check_items_snapshot: CheckItem[];
  agreement_label_snapshot: string;
  company_name_snapshot: string;
  pledge_number: string;
};

function PaperPledgePrintContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const templateId = searchParams.get("template_id") || "";
  const deliveryId = searchParams.get("delivery_id") || "";
  const started = useRef(false);
  const [delivery, setDelivery] = useState<PaperDelivery | null>(null);
  const [message, setMessage] = useState("紙の誓約書を準備しています...");
  const sections = useMemo(() => {
    const text = delivery?.body_snapshot || "";
    const marker = text.indexOf("【重要】");
    return marker < 0
      ? { introduction: text, important: "" }
      : { introduction: text.slice(0, marker).trim(), important: text.slice(marker).trim() };
  }, [delivery?.body_snapshot]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const load = async () => {
      try {
        const response = deliveryId
          ? await fetch(`/api/admin/pledges/paper?delivery_id=${encodeURIComponent(deliveryId)}`, { cache: "no-store" })
          : await fetch("/api/admin/pledges/paper", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ template_id: templateId }),
          });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "紙の誓約書を作成できませんでした");
        setDelivery(data.delivery);
        setMessage("");
        if (!deliveryId && data.delivery?.id) {
          const next = `/admin/pledges/print?delivery_id=${encodeURIComponent(data.delivery.id)}`;
          window.history.replaceState(null, "", next);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "紙の誓約書を作成できませんでした");
      }
    };
    void load();
  }, [deliveryId, templateId]);

  return (
    <main className="pledge-paper-print-page">
      <div className="pledge-paper-print-toolbar no-print">
        <button type="button" onClick={() => router.back()}><ArrowLeft size={18} aria-hidden="true" />戻る</button>
        <div><strong>紙の誓約書</strong><span>氏名と日付は本人が手書きします</span></div>
        <button type="button" className="btn-primary" onClick={() => window.print()} disabled={!delivery}>
          <Printer size={18} aria-hidden="true" />印刷
        </button>
      </div>

      {message || !delivery ? (
        <div className="pledge-paper-print-message">{message}</div>
      ) : (
        <article className="pledge-paper-sheet">
          <div className="pledge-paper-sheet__number">誓約書No. {delivery.pledge_number}</div>
          <h1>{delivery.title_snapshot}</h1>
          <p className="pledge-paper-sheet__company">{delivery.company_name_snapshot}</p>
          <div className="pledge-paper-sheet__body">
            {sections.introduction.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => (
              <p key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>
            ))}
          </div>
          <div className="pledge-paper-sheet__checks">
            {delivery.check_items_snapshot.map((item) => (
              <div key={item.id}><span aria-hidden="true" /><p>{item.text}</p></div>
            ))}
          </div>
          {sections.important && (
            <div className="pledge-paper-sheet__important">
              {sections.important.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => (
                <p key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>
              ))}
            </div>
          )}
          <section className="pledge-paper-sheet__signature">
            <p>{delivery.agreement_label_snapshot}</p>
            <div><span>誓約者氏名（自署）</span><i /></div>
            <div><span>誓約日</span><i /><b>年</b><i /><b>月</b><i /><b>日</b></div>
          </section>
        </article>
      )}
    </main>
  );
}

export default function PaperPledgePrintPage() {
  return <Suspense fallback={<main className="pledge-paper-print-page"><div className="pledge-paper-print-message">読み込み中...</div></main>}><PaperPledgePrintContent /></Suspense>;
}

