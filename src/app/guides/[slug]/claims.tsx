"use client";

import { Fragment, useRef } from "react";
import { LABEL_INFO } from "@/lib/evidence";
import type { ClaimT } from "@/lib/schema";

export type Jump = (id: string) => void;
export interface ChipHandlers {
  jump: Jump;
  show: (id: string, el: HTMLElement, pinned?: boolean) => void;
  hide: () => void;
  openId: string | null;
}

/** Short scenario name for inline references like "(s3, s4)". */
export const shortLabel = (label: string) => (label.length > 34 ? `${label.slice(0, 32).trimEnd()}…` : label);

/**
 * Renders guide text with inline citations ("(c11, c35)" or "c11, c15.") turned into evidence chips and
 * scenario ids ("s3") replaced by scenario names. `extra` chips (the item's claim_ids) are appended, minus
 * any already cited inline.
 */
export function Rich({
  text,
  extra = [],
  claims,
  scenarios,
  h,
}: {
  text: string;
  extra?: string[];
  claims: Map<string, ClaimT>;
  scenarios: Map<string, string>;
  h: ChipHandlers;
}) {
  const withNames = text.replace(/\b(s\d+)\b/g, (m) => (scenarios.has(m) ? `“${shortLabel(scenarios.get(m)!)}”` : m));
  const parts = withNames.split(/(\(?\bc\d+(?:\s*,\s*c\d+)*\b\)?\.?)/g);
  const inline = new Set<string>();
  const nodes = parts.map((part, i) => {
    const ids = part.match(/c\d+/g);
    if (i % 2 === 1 && ids && ids.every((id) => claims.has(id))) {
      ids.forEach((id) => inline.add(id));
      return <Chips key={i} ids={ids} claims={claims} h={h} />;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
  const rest = [...new Set(extra)].filter((id) => !inline.has(id));
  return (
    <>
      {nodes}
      {rest.length > 0 && <Chips ids={rest} claims={claims} h={h} />}
    </>
  );
}

/** Inline evidence chips. Hover/focus shows the shared preview; click jumps to the claim (on touch, the first tap previews). */
export function Chips({ ids, claims, h }: { ids: string[]; claims: Map<string, ClaimT>; h: ChipHandlers }) {
  const lastPointer = useRef("mouse");
  if (!ids.length) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {[...new Set(ids)].map((id) => {
        const c = claims.get(id);
        if (!c) return null;
        const info = LABEL_INFO[c.label];
        return (
          <button
            key={id}
            type="button"
            onPointerDown={(e) => (lastPointer.current = e.pointerType)}
            onPointerEnter={(e) => e.pointerType === "mouse" && h.show(id, e.currentTarget)}
            onPointerLeave={(e) => e.pointerType === "mouse" && h.hide()}
            onFocus={(e) => h.show(id, e.currentTarget)}
            onBlur={h.hide}
            onClick={(e) => {
              if (lastPointer.current === "touch" && h.openId !== id) {
                h.show(id, e.currentTarget, true);
                return;
              }
              h.jump(id);
            }}
            aria-label={`${info.name} claim ${id}. Jump to evidence.`}
            aria-describedby={h.openId === id ? "claim-preview" : undefined}
            className={`rounded px-1 py-px font-mono text-[11px] ring-1 ring-inset transition hover:ring-accent ${
              c.label === "unknown" ? "bg-surface-2 text-faint ring-line" : "bg-surface-3 text-muted ring-line-strong"
            }`}
          >
            {info.icon}
            {id}
          </button>
        );
      })}
    </span>
  );
}

export function ClaimPreview({ claim, anchor, onEnter, onLeave, onJump }: { claim: ClaimT; anchor: HTMLElement; onEnter: () => void; onLeave: () => void; onJump: () => void }) {
  const info = LABEL_INFO[claim.label];
  const rect = anchor.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null; // chip scrolled out of view
  const vw = window.innerWidth;
  const width = Math.min(300, vw - 16);
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, vw - width - 8));
  const above = rect.top > 240;
  const style: React.CSSProperties = above
    ? { left, width, top: rect.top - 8, transform: "translateY(-100%)" }
    : { left, width, top: rect.bottom + 8 };
  return (
    <div
      id="claim-preview"
      role="tooltip"
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className="fixed z-50 rounded-lg border border-line-strong bg-surface-3 p-3 text-left text-xs leading-relaxed shadow-2xl"
    >
      <span className="block font-mono text-[10px] uppercase tracking-wider text-faint">
        {info.icon} {info.name} · {claim.id}
      </span>
      <span className="mt-1 block text-ink">{claim.text}</span>
      {claim.quote && (
        <span className="mt-1.5 block border-l-2 border-accent/50 pl-2 font-mono text-muted">
          “{claim.quote.slice(0, 220)}
          {claim.quote.length > 220 ? "…" : ""}”
        </span>
      )}
      {claim.note && <span className="mt-1.5 block italic text-amber-200/80">{claim.note}</span>}
      <button type="button" onClick={onJump} className="mt-2 text-accent hover:underline">
        Jump to evidence →
      </button>
    </div>
  );
}
