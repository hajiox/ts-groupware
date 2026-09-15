export const CLIENT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const CLIENT_IMAGE_MAX_DIMENSION = 1600;
export const CLIENT_IMAGE_JPEG_QUALITY = 0.82;

export type ClientImageUploadMode = "compress" | "compress-if-needed" | "original";

export type ClientUploadData = {
  url: string;
  viewUrl?: string;
  name?: string;
  type?: string;
  driveId?: string;
  webViewLink?: string;
  error?: string;
};

type UploadFileInfo = Pick<File, "size" | "type">;

export function clientUploadAction(file: UploadFileInfo, imageMode: ClientImageUploadMode) {
  if (file.size <= 0) return "reject-empty" as const;
  if (!file.type.startsWith("image/")) {
    return file.size > CLIENT_UPLOAD_MAX_BYTES ? "reject-too-large" as const : "original" as const;
  }
  if (imageMode === "original") {
    return file.size > CLIENT_UPLOAD_MAX_BYTES ? "reject-original-too-large" as const : "original" as const;
  }
  if (imageMode === "compress-if-needed" && file.size <= CLIENT_UPLOAD_MAX_BYTES) {
    return "original" as const;
  }
  return "compress" as const;
}

function compressedImageName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, "");
  return `${baseName || "image"}.jpg`;
}

async function loadImageSource(file: File) {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Some browsers expose createImageBitmap but cannot decode every image type they display.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像を読み込めませんでした"));
      img.src = objectUrl;
    });

    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function compressImage(file: File) {
  let image: Awaited<ReturnType<typeof loadImageSource>>;
  try {
    image = await loadImageSource(file);
  } catch {
    throw new Error("この画像形式を送信用に変換できませんでした");
  }

  try {
    const scale = Math.min(1, CLIENT_IMAGE_MAX_DIMENSION / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像を送信用に変換できませんでした");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", CLIENT_IMAGE_JPEG_QUALITY);
    });
    if (!blob) throw new Error("画像を送信用に変換できませんでした");

    if (scale === 1 && blob.size >= file.size) return file;
    return new File([blob], compressedImageName(file.name), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } finally {
    image.close();
  }
}

export async function prepareClientUploadFile(
  file: File,
  imageMode: ClientImageUploadMode = "compress-if-needed",
) {
  const action = clientUploadAction(file, imageMode);
  if (action === "reject-empty") throw new Error("空のファイルはアップロードできません");
  if (action === "reject-too-large") throw new Error("ファイルサイズは4MB以内にしてください");
  if (action === "reject-original-too-large") {
    throw new Error("元画像は4MB以内にしてください。縮小してアップロードへ戻すと送信できます");
  }
  if (action === "original") return file;

  const preparedFile = await compressImage(file);
  if (preparedFile.size > CLIENT_UPLOAD_MAX_BYTES) {
    throw new Error("画像を4MB以内に縮小できませんでした");
  }
  return preparedFile;
}

export async function uploadClientFile(
  file: File,
  options: {
    imageMode?: ClientImageUploadMode;
    fallbackError?: string;
  } = {},
) {
  const preparedFile = await prepareClientUploadFile(file, options.imageMode);
  const formData = new FormData();
  formData.append("file", preparedFile);

  const response = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });
  const data = await response.json().catch(() => ({})) as Partial<ClientUploadData>;
  if (!response.ok) {
    throw new Error(data.error || options.fallbackError || "ファイルのアップロードに失敗しました");
  }
  if (typeof data.url !== "string" || !data.url) {
    throw new Error(options.fallbackError || "ファイルの保存先を取得できませんでした");
  }

  return { data: data as ClientUploadData, preparedFile };
}
