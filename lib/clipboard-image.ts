const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
};

export function getClipboardImageFile(clipboardData: DataTransfer | null) {
  if (!clipboardData) return null;

  for (const item of Array.from(clipboardData.items || [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return normalizeClipboardImageFile(file);
  }

  for (const file of Array.from(clipboardData.files || [])) {
    if (file.type.startsWith("image/")) return normalizeClipboardImageFile(file);
  }

  return null;
}

function normalizeClipboardImageFile(file: File) {
  if (file.name && file.name.trim()) return file;

  const ext = MIME_EXTENSION[file.type] || "png";
  return new File([file], `pasted-image-${Date.now()}.${ext}`, {
    type: file.type || "image/png",
    lastModified: Date.now(),
  });
}
