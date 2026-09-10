/**
 * YT APPEND CONTROLLER — single-flighted continuation walk behind
 * YouTube search pagination (R8-P3, ported from TSF-MUSIC v3.4.5
 * src/search/ytAppend.ts).
 *
 * Semantics:
 *   • single-flight GEN-KEYED: concurrent append() calls for the same
 *     generation share ONE fetchMore; a NEW generation never queues
 *     behind a doomed walk.
 *   • transport failure (`error: true`): token KEPT, hasMore stays true —
 *     a network blip is not end-of-catalog.
 *   • honest end: no continuation → hasMore false + end note.
 *   • stale generation: no state publishes at all.
 *   • productive append clears any stale error note.
 */

import type { SearchRow } from './rows';

export interface YtAppendPage {
  tracks: SearchRow[];
  continuation?: string;
  error?: boolean;
}

export interface YtAppendPorts {
  fetchMore: (cont: string, signal?: AbortSignal) => Promise<YtAppendPage>;
  getCont: () => string | null;
  setCont: (c: string | null) => void;
  getRows: () => SearchRow[];
  publishRows: (rows: SearchRow[]) => void;
  publishState: (s: { hasMore: boolean; endNote: string | null }) => void;
  isCurrentGen: (gen: number) => boolean;
  getSignal: () => AbortSignal | undefined;
  setBusy?: (b: boolean) => void;
}

export const YT_END_NOTE = "That's everything YouTube found";
export const YT_RETRY_NOTE = "Couldn't load more — check your connection";

/** Merge rows by engine id, preserving order (first wins). */
export function mergeUniqueRows(base: SearchRow[], extra: SearchRow[]): SearchRow[] {
  const seen = new Set(base.map((r) => r.id));
  const out = [...base];
  for (const r of extra) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

export class YtAppendController {
  private inFlight: { gen: number; p: Promise<void> } | null = null;

  constructor(private ports: YtAppendPorts) {}

  append(gen: number, opts?: { silent?: boolean }): Promise<void> {
    if (this.inFlight && this.inFlight.gen === gen) return this.inFlight.p;
    const cont = this.ports.getCont();
    if (!cont) return Promise.resolve();
    if (!opts?.silent && this.ports.setBusy) this.ports.setBusy(true);
    const slot: { gen: number; p: Promise<void> } = { gen, p: Promise.resolve() };
    slot.p = (async () => {
      try {
        const page = await this.ports.fetchMore(cont, this.ports.getSignal());
        if (!this.ports.isCurrentGen(gen)) return;
        if (page.error) {
          this.ports.publishState({ hasMore: true, endNote: YT_RETRY_NOTE });
          return;
        }
        if (page.tracks.length) {
          const merged = mergeUniqueRows(this.ports.getRows(), page.tracks);
          this.ports.publishRows(merged);
        }
        this.ports.setCont(page.continuation ?? null);
        this.ports.publishState(
          page.continuation
            ? { hasMore: true, endNote: null }
            : { hasMore: false, endNote: YT_END_NOTE },
        );
      } catch {
        if (this.ports.isCurrentGen(gen)) {
          this.ports.publishState({ hasMore: true, endNote: YT_RETRY_NOTE });
        }
      } finally {
        if (this.inFlight === slot) this.inFlight = null;
        if (!opts?.silent && this.ports.setBusy && this.ports.isCurrentGen(gen)) {
          this.ports.setBusy(false);
        }
      }
    })();
    this.inFlight = slot;
    return slot.p;
  }
}
