// Local (no-LLM, no-token) relevance filtering to keep prompts small.
// Cleans datasheet text, chunks it, and selects only the chunks relevant to
// the parsed fault — so we send ~4k relevant chars instead of a blind 12k slice.

import { ParseResult } from "./zephyrParser";

// Collapse whitespace and drop lines that repeat across the doc (page
// headers/footers), which are pure token waste.
export function cleanText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const freq = new Map<string, number>();
  for (const l of lines) {
    const t = l.trim();
    if (t.length >= 3 && t.length <= 80) freq.set(t, (freq.get(t) || 0) + 1);
  }
  const repeated = new Set([...freq.entries()].filter(([, n]) => n >= 5).map(([t]) => t));
  return lines
    .map((l) => l.trim())
    .filter((l) => !repeated.has(l)) // keep blank lines to preserve paragraph breaks
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function chunkText(text: string, size = 700): string[] {
  // Prefer paragraph boundaries; fall back to fixed windows.
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > size) {
      if (buf) chunks.push(buf);
      if (p.length > size) {
        for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
        buf = "";
      } else {
        buf = p;
      }
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Terms that make a datasheet section worth sending, derived from the fault.
// Fault-specific terms are weighted heavily; generic SoC anchors lightly.
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "fault", "error", "cpu",
  "current", "thread", "address", "instruction", "halting", "system",
]);

function deriveTerms(parsed: ParseResult): { specific: string[]; anchors: string[] } {
  const specific = new Set<string>();
  const add = (s?: string | null) => {
    if (!s) return;
    s.toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^r\d{1,2}$/.test(w))
      .forEach((w) => specific.add(w));
  };
  for (const f of parsed.faults) {
    add(f.faultType);
    add(f.reasonText);
    f.detail.forEach(add);
    if (f.currentThread) add(f.currentThread.replace(/0x[0-9a-f]+|\(|\)/gi, ""));
  }
  for (const a of parsed.assertions) {
    add(a.expression);
    add(a.file.split("/").pop());
  }
  for (const r of parsed.registers)
    if (/^(bfar|cfsr|hfsr|mmfar|sp|psp|msp)$/i.test(r.name)) specific.add(r.name.toLowerCase());

  const anchors = [
    "memory", "map", "sram", "flash", "ram", "nvic", "interrupt", "irq",
    "vector", "clock", "reset", "stack", "exception",
  ];
  return { specific: [...specific], anchors };
}

export interface TrimResult {
  selected: string;
  originalChars: number;
  selectedChars: number;
  tokensSaved: number; // rough estimate at ~4 chars/token
}

export function selectRelevantDatasheet(
  rawDatasheet: string,
  parsed: ParseResult,
  maxChars = 4000
): TrimResult {
  const cleaned = cleanText(rawDatasheet || "");
  const originalChars = (rawDatasheet || "").length;
  if (!cleaned) return { selected: "", originalChars, selectedChars: 0, tokensSaved: 0 };
  if (cleaned.length <= maxChars) {
    return {
      selected: cleaned,
      originalChars,
      selectedChars: cleaned.length,
      tokensSaved: Math.max(0, Math.round((originalChars - cleaned.length) / 4)),
    };
  }

  const { specific, anchors } = deriveTerms(parsed);
  const chunks = chunkText(cleaned);
  const countCapped = (hay: string, term: string) => Math.min(hay.split(term).length - 1, 2);
  const scored = chunks.map((c, idx) => {
    const lc = c.toLowerCase();
    let score = 0;
    for (const t of specific) score += 3 * countCapped(lc, t);
    for (const t of anchors) score += 1 * countCapped(lc, t);
    return { idx, c, score };
  });

  const hasHits = scored.some((s) => s.score > 0);
  let chosen: { idx: number; c: string }[];
  if (hasHits) {
    chosen = [...scored]
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0);
  } else {
    // No keyword hits — fall back to the start of the doc (often the overview/memory map)
    chosen = scored;
  }

  const picked: { idx: number; c: string }[] = [];
  let total = 0;
  for (const ch of chosen) {
    if (total + ch.c.length > maxChars && picked.length) break;
    picked.push({ idx: ch.idx, c: ch.c });
    total += ch.c.length;
    if (total >= maxChars) break;
  }
  // Restore document order so the excerpt reads coherently
  picked.sort((a, b) => a.idx - b.idx);
  const selected = picked.map((p) => p.c).join("\n\n…\n\n");

  return {
    selected,
    originalChars,
    selectedChars: selected.length,
    tokensSaved: Math.max(0, Math.round((originalChars - selected.length) / 4)),
  };
}
