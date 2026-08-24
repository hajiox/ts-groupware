"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink } from "lucide-react";

type Assignment = {
  id: string;
  dm_group_id: string | null;
  signer_name: string | null;
  pledged_at: string | null;
  delivery: {
    title_snapshot: string;
    body_snapshot: string;
    check_items_snapshot: Array<{ id: string; text: string }>;
    agreement_label_snapshot: string;
    company_name_snapshot: string;
  };
};

export default function PledgePdfViewerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [message, setMessage] = useState("PDFを読み込み中...");
  const pdfUrl = `/api/pledges/pdf?assignment_id=${encodeURIComponent(id)}`;
  const bodySections = useMemo(() => {
    const text = assignment?.delivery.body_snapshot || "";
    const markerIndex = text.indexOf("【重要】");
    return markerIndex < 0
      ? { introduction: text, important: "" }
      : { introduction: text.slice(0, markerIndex).trim(), important: text.slice(markerIndex).trim() };
  }, [assignment?.delivery.body_snapshot]);

  useEffect(() => {
    fetch(`/api/pledges?assignment_id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || "誓約書を読み込めませんでした");
        setAssignment(data.assignments?.[0] || null);
        setMessage("");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "誓約書を読み込めませんでした"));
  }, [id]);

  function goBack() {
    router.push(assignment?.dm_group_id ? `/chat/${assignment.dm_group_id}` : "/members");
  }

  return (
    <div className="pledge-pdf-viewer">
      <header className="top-header pledge-pdf-viewer__header">
        <button type="button" className="top-header__back" onClick={goBack} aria-label="DMへ戻る">‹</button>
        <h1 className="top-header__title">{assignment?.delivery.title_snapshot || "誓約書PDF"}</h1>
        <a href={pdfUrl} target="_blank" rel="noreferrer" className="pledge-pdf-viewer__open" aria-label="PDFを別画面で開く">
          <ExternalLink size={17} aria-hidden="true" />
        </a>
      </header>
      {message || !assignment ? (
        <main className="pledge-pdf-viewer__message">{message}</main>
      ) : (
        <main className="pledge-pdf-paper-wrap">
          <article className="pledge-pdf-paper">
            <h2>{assignment.delivery.title_snapshot}</h2>
            <div className="pledge-pdf-paper__body">
              {bodySections.introduction.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 10)}`}>{paragraph}</p>)}
            </div>
            <div className="pledge-pdf-paper__checks">
              {assignment.delivery.check_items_snapshot.map((item) => (
                <div key={item.id}><span><Check size={13} aria-hidden="true" /></span><p>{item.text}</p></div>
              ))}
            </div>
            {bodySections.important && (
              <div className="pledge-pdf-paper__body pledge-pdf-paper__important">
                {bodySections.important.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={`${index}:${paragraph.slice(0, 10)}`}>{paragraph}</p>)}
              </div>
            )}
            <section className="pledge-pdf-paper__signature">
              <p>{assignment.delivery.agreement_label_snapshot}</p>
              <dl>
                <div><dt>会社名</dt><dd>{assignment.delivery.company_name_snapshot}</dd></div>
                <div><dt>誓約者</dt><dd>{assignment.signer_name || "-"}</dd></div>
                <div><dt>誓約日</dt><dd>{assignment.pledged_at ? new Date(assignment.pledged_at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : "-"}</dd></div>
              </dl>
            </section>
          </article>
        </main>
      )}
    </div>
  );
}
