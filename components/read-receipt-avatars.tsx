"use client";

import { SafeLineAvatar } from "@/components/safe-line-avatar";

export type ReadReceiptUser = {
  user_id: string;
  last_read_at: string;
  display_name: string;
  picture_url: string | null;
};

const MAX_VISIBLE_READERS = 3;

export function ReadReceiptAvatars({ readers }: { readers: ReadReceiptUser[] }) {
  const sortedReaders = [...readers].sort((a, b) => (
    new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime()
  ));
  const visibleReaders = sortedReaders.slice(0, MAX_VISIBLE_READERS);
  const remainingReaders = sortedReaders.slice(MAX_VISIBLE_READERS);

  return (
    <div
      className="read-receipt"
      aria-label={`既読 ${sortedReaders.length}人: ${sortedReaders.map(reader => reader.display_name).join("、")}`}
    >
      <span className="read-receipt__label">既読 {sortedReaders.length}</span>
      <span className="read-receipt__avatars">
        {visibleReaders.map(reader => (
          <button
            key={reader.user_id}
            type="button"
            className="read-receipt__avatar"
            aria-label={`既読: ${reader.display_name}`}
            title={reader.display_name}
          >
            <SafeLineAvatar
              name={reader.display_name}
              pictureUrl={reader.picture_url}
              size={20}
              className="read-receipt__image"
              alt=""
            />
            <span className="read-receipt__tooltip" role="tooltip">{reader.display_name}</span>
          </button>
        ))}
        {remainingReaders.length > 0 && (
          <button
            type="button"
            className="read-receipt__avatar read-receipt__more"
            aria-label={`ほかの既読者: ${remainingReaders.map(reader => reader.display_name).join("、")}`}
            title={remainingReaders.map(reader => reader.display_name).join("、")}
          >
            +{remainingReaders.length}
            <span className="read-receipt__tooltip" role="tooltip">
              {remainingReaders.map(reader => reader.display_name).join("、")}
            </span>
          </button>
        )}
      </span>
    </div>
  );
}
