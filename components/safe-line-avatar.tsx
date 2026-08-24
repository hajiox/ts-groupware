"use client";

import { useMemo, useState } from "react";
import { normalizeLinePictureUrl } from "@/lib/line-picture";

type SafeLineAvatarProps = {
  name?: string | null;
  pictureUrl?: string | null;
  size?: number;
  className?: string;
  title?: string;
  alt?: string;
  background?: string;
};

function isTsgAiName(value?: string | null) {
  const normalized = (value || "").trim();
  return normalized === "TSG君" || normalized === "TSGくん";
}

export function SafeLineAvatar({
  name,
  pictureUrl,
  size = 36,
  className = "avatar",
  title,
  alt,
  background = "#3b82f6",
}: SafeLineAvatarProps) {
  const normalizedSrc = useMemo(() => normalizeLinePictureUrl(pictureUrl), [pictureUrl]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const displayName = name || "";
  const avatarSizeStyle = {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    maxWidth: size,
    maxHeight: size,
    flex: `0 0 ${size}px`,
  };

  if (isTsgAiName(displayName)) {
    return (
      <div
        className={`${className} tsg-ai-avatar`}
        title={title ?? displayName}
        style={avatarSizeStyle}
        role="img"
        aria-label={alt ?? displayName}
      >
        <span className="tsg-ai-avatar__antenna" />
        <span className="tsg-ai-avatar__ear tsg-ai-avatar__ear--left" />
        <span className="tsg-ai-avatar__ear tsg-ai-avatar__ear--right" />
        <span className="tsg-ai-avatar__face">
          <span className="tsg-ai-avatar__eyes" />
          <span className="tsg-ai-avatar__mouth" />
        </span>
      </div>
    );
  }

  if (normalizedSrc && failedSrc !== normalizedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={normalizedSrc}
        alt={alt ?? displayName}
        title={title}
        className={className}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(normalizedSrc)}
      />
    );
  }

  return (
    <div
      className="avatar-placeholder"
      title={title}
      style={{ width: size, height: size, background, fontSize: size * 0.4 }}
    >
      {displayName.trim().charAt(0) || "?"}
    </div>
  );
}
