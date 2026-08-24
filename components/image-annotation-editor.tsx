"use client";

import { Circle, RotateCcw, Save, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type AnnotationMode = "rect" | "circle";

type AnnotationShape = {
  id: string;
  mode: AnnotationMode;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type ImageAnnotationEditorProps = {
  imageUrl: string;
  imageName: string;
  saving?: boolean;
  onCancel: () => void;
  onSave: (file: File) => Promise<void> | void;
};

function editorImageUrl(url: string) {
  if (url.startsWith("/") || url.startsWith("blob:") || url.startsWith("data:")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function makeShape(mode: AnnotationMode, start: Point, end: Point): AnnotationShape {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode,
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function strokeWidthFor(width: number, height: number) {
  return Math.max(6, Math.round(Math.min(width, height) * 0.012));
}

function drawShape(ctx: CanvasRenderingContext2D, shape: AnnotationShape) {
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = strokeWidthFor(ctx.canvas.width, ctx.canvas.height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (shape.mode === "circle") {
    ctx.beginPath();
    ctx.ellipse(
      shape.x + shape.width / 2,
      shape.y + shape.height / 2,
      Math.max(1, shape.width / 2),
      Math.max(1, shape.height / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    return;
  }

  ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
}

function outputFileName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, "").trim() || "image";
  return `${baseName}-marked.jpg`;
}

export function ImageAnnotationEditor({
  imageUrl,
  imageName,
  saving = false,
  onCancel,
  onSave,
}: ImageAnnotationEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const startPointRef = useRef<Point | null>(null);
  const [mode, setMode] = useState<AnnotationMode>("rect");
  const [shapes, setShapes] = useState<AnnotationShape[]>([]);
  const [draftShape, setDraftShape] = useState<AnnotationShape | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  const sourceUrl = useMemo(() => editorImageUrl(imageUrl), [imageUrl]);

  useEffect(() => {
    let canceled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (canceled) return;
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
      }
      setShapes([]);
      setDraftShape(null);
      setImageReady(true);
      setLoadError("");
    };
    img.onerror = () => {
      if (canceled) return;
      setImageReady(false);
      setLoadError("画像を読み込めませんでした");
    };
    setImageReady(false);
    setLoadError("");
    img.src = sourceUrl;

    return () => {
      canceled = true;
    };
  }, [sourceUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !image || !ctx || !imageReady) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    shapes.forEach((shape) => drawShape(ctx, shape));
    if (draftShape) drawShape(ctx, draftShape);
  }, [draftShape, imageReady, shapes]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancel();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, saving]);

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>): Point | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * (canvas.height / rect.height))),
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!imageReady || saving) return;
    const point = canvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startPointRef.current = point;
    setDraftShape(makeShape(mode, point, point));
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const start = startPointRef.current;
    if (!start || !imageReady || saving) return;
    const point = canvasPoint(event);
    if (!point) return;
    setDraftShape(makeShape(mode, start, point));
  }

  function finishDraft() {
    const draft = draftShape;
    startPointRef.current = null;
    setDraftShape(null);
    if (!draft || draft.width < 8 || draft.height < 8) return;
    setShapes((current) => [...current, draft]);
  }

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas || shapes.length === 0 || saving) return;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.94);
    });
    if (!blob) {
      alert("画像の保存に失敗しました");
      return;
    }

    await onSave(new File([blob], outputFileName(imageName), {
      type: "image/jpeg",
      lastModified: Date.now(),
    }));
  }

  return (
    <div className="annotation-overlay" role="dialog" aria-modal="true" aria-label="画像マーキング">
      <div className="annotation-editor">
        <header className="annotation-editor__header">
          <div>
            <p className="annotation-editor__eyebrow">Image Markup</p>
            <h2>赤丸・赤枠を追加</h2>
          </div>
          <button type="button" className="annotation-editor__icon-btn" onClick={onCancel} disabled={saving} aria-label="閉じる">
            <X size={20} />
          </button>
        </header>

        <div className="annotation-editor__toolbar" role="toolbar" aria-label="マーキングツール">
          <button
            type="button"
            className={`annotation-editor__tool${mode === "rect" ? " annotation-editor__tool--active" : ""}`}
            onClick={() => setMode("rect")}
            disabled={saving}
          >
            <Square size={18} />
            <span>赤枠</span>
          </button>
          <button
            type="button"
            className={`annotation-editor__tool${mode === "circle" ? " annotation-editor__tool--active" : ""}`}
            onClick={() => setMode("circle")}
            disabled={saving}
          >
            <Circle size={18} />
            <span>赤丸</span>
          </button>
          <button
            type="button"
            className="annotation-editor__tool"
            onClick={() => setShapes((current) => current.slice(0, -1))}
            disabled={saving || shapes.length === 0}
          >
            <RotateCcw size={18} />
            <span>戻す</span>
          </button>
          <button
            type="button"
            className="annotation-editor__tool annotation-editor__tool--danger"
            onClick={() => setShapes([])}
            disabled={saving || shapes.length === 0}
          >
            <Trash2 size={18} />
            <span>全消去</span>
          </button>
        </div>

        <div className="annotation-editor__canvas-wrap">
          {loadError ? (
            <div className="annotation-editor__error">{loadError}</div>
          ) : (
            <canvas
              ref={canvasRef}
              className="annotation-editor__canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDraft}
              onPointerCancel={finishDraft}
            />
          )}
        </div>

        <footer className="annotation-editor__footer">
          <button type="button" className="annotation-editor__cancel" onClick={onCancel} disabled={saving}>
            キャンセル
          </button>
          <button
            type="button"
            className="annotation-editor__save"
            onClick={handleSave}
            disabled={saving || !imageReady || shapes.length === 0}
          >
            <Save size={18} />
            <span>{saving ? "保存中" : "保存して差し替え"}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
