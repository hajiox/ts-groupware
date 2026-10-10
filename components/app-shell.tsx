"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  const isChat = usePathname().startsWith("/chat/");
  const shellRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!isChat || !shell || !window.visualViewport) return;

    // iOS keyboards resize the visual viewport without resizing 100dvh.
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      if (Number.isFinite(viewport.height) && viewport.height > 0) {
        shell.style.setProperty("--chat-viewport-height", `${viewport.height}px`);
      }
      shell.style.setProperty("--chat-viewport-top", `${Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0}px`);
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", scheduleUpdate);
    viewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("pageshow", scheduleUpdate);

    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", scheduleUpdate);
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("pageshow", scheduleUpdate);
      shell.style.removeProperty("--chat-viewport-height");
      shell.style.removeProperty("--chat-viewport-top");
    };
  }, [isChat]);

  return <div ref={shellRef} className={`app-shell${isChat ? " app-shell--chat" : ""}`}>{children}</div>;
}
