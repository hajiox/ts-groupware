"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const TRIGGER_DISTANCE = 78;
const MAX_DISTANCE = 116;

function isFormControl(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, button, [contenteditable='true']"));
}

function hasScrollableParentAwayFromTop(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  let element: HTMLElement | null = target;
  while (element && element !== document.body && element !== document.documentElement) {
    const style = window.getComputedStyle(element);
    const scrollable = /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    if (scrollable && element.scrollTop > 2) return true;
    element = element.parentElement;
  }
  return false;
}

function getPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

export function PullToRefresh() {
  const pathname = usePathname();
  const disabled = pathname.startsWith("/admin/shifts/print") || pathname.startsWith("/pledges/pdf/");
  const startYRef = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (disabled || pathname.startsWith("/board") || pathname.startsWith("/chat")) return;

    const supportsTouch = window.matchMedia("(hover: none), (pointer: coarse)").matches;
    if (!supportsTouch) return;

    const reset = () => {
      startYRef.current = null;
      distanceRef.current = 0;
      setDistance(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (refreshing) return;
      if (getPageScrollTop() > 2) return;
      if (isFormControl(event.target)) return;
      if (hasScrollableParentAwayFromTop(event.target)) return;
      startYRef.current = event.touches[0]?.clientY ?? null;
      distanceRef.current = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (refreshing || startYRef.current === null) return;
      if (getPageScrollTop() > 2) {
        reset();
        return;
      }

      const currentY = event.touches[0]?.clientY ?? startYRef.current;
      const rawDistance = currentY - startYRef.current;
      if (rawDistance <= 0) {
        startYRef.current = null;
        distanceRef.current = 0;
        setDistance(0);
        return;
      }

      // Stop the browser rubber-band/pull-to-refresh from moving fixed footers.
      event.preventDefault();
      const nextDistance = Math.min(MAX_DISTANCE, Math.round(rawDistance * 0.62));
      distanceRef.current = nextDistance;
      setDistance(nextDistance);
    };

    const onTouchEnd = () => {
      if (refreshing) return;
      const shouldRefresh = distanceRef.current >= TRIGGER_DISTANCE;
      if (!shouldRefresh) {
        reset();
        return;
      }

      setRefreshing(true);
      setDistance(TRIGGER_DISTANCE);
      window.setTimeout(() => window.location.reload(), 120);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [disabled, pathname, refreshing]);

  if (disabled) return null;

  const progress = refreshing ? 1 : Math.min(1, distance / TRIGGER_DISTANCE);
  const visible = refreshing || distance > 8;
  const label = refreshing ? "更新中..." : progress >= 1 ? "離して更新" : "引っぱって更新";

  return (
    <div
      className={`pull-refresh${visible ? " pull-refresh--visible" : ""}${refreshing ? " pull-refresh--loading" : ""}`}
      style={{
        opacity: visible ? Math.max(0.35, progress) : 0,
        transform: `translate3d(-50%, ${visible ? Math.min(18, distance * 0.18) : -24}px, 0)`,
      }}
      aria-hidden={!visible}
    >
      <span className="pull-refresh__icon" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
