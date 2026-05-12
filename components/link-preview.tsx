"use client";

import { useEffect, useState } from "react";

/**
 * URL正規表現: テキスト中のhttp/httpsリンクを検出
 */
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

type OgpData = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
};

/**
 * テキスト中のURLを<a>タグに変換してReact要素の配列を返す
 */
export function linkifyText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match;

  const regex = new RegExp(URL_REGEX.source, "g");
  while ((match = regex.exec(text)) !== null) {
    // URL前のテキスト
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const url = match[0];
    // 末尾の句読点を除外
    const cleaned = url.replace(/[.,;:!?)]+$/, "");

    parts.push(
      <a
        key={`link-${match.index}`}
        href={cleaned}
        target="_blank"
        rel="noopener noreferrer"
        className="post-link"
      >
        {cleaned}
      </a>
    );

    // 除外した句読点をテキストとして追加
    if (cleaned.length < url.length) {
      parts.push(url.slice(cleaned.length));
    }

    lastIndex = match.index + url.length;
  }

  // 残りのテキスト
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

/**
 * テキストからURLを抽出（重複排除）
 */
export function extractUrls(text: string): string[] {
  const regex = new RegExp(URL_REGEX.source, "g");
  const urls: string[] = [];
  const seen = new Set<string>();
  let match;

  while ((match = regex.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?)]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

/**
 * 単一のOGPプレビューカード
 */
function OgpCard({ url }: { url: string }) {
  const [data, setData] = useState<OgpData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/ogp?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && (d.title || d.description || d.image)) {
          setData(d);
        } else if (!cancelled) {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error || !data) return null;

  // ドメイン名を表示用に抽出
  let domain = "";
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = url;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="ogp-card"
      aria-label={data.title || url}
    >
      {data.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.image}
          alt=""
          className="ogp-card__image"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <div className="ogp-card__body">
        {data.title && (
          <div className="ogp-card__title">{data.title}</div>
        )}
        {data.description && (
          <div className="ogp-card__desc">{data.description}</div>
        )}
        <div className="ogp-card__domain">
          🔗 {data.siteName || domain}
        </div>
      </div>
    </a>
  );
}

/**
 * 投稿テキスト内のURLのOGPプレビューを表示するコンポーネント
 * 最大3件まで表示
 */
export function OgpPreviews({ text }: { text: string }) {
  const urls = extractUrls(text).slice(0, 3);
  if (urls.length === 0) return null;

  return (
    <div className="ogp-previews">
      {urls.map((url) => (
        <OgpCard key={url} url={url} />
      ))}
    </div>
  );
}
