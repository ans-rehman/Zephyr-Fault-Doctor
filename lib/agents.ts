import { GoogleGenerativeAI } from "@google/generative-ai";
import { ParseResult } from "./zephyrParser";
import { knowledgeContext } from "./zephyrKnowledge";

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function client(apiKey: string) {
  if (!apiKey) throw new Error("No Gemini API key provided");
  return new GoogleGenerativeAI(apiKey);
}

// Ask Gemini for JSON and parse defensively (strip code fences if present).
async function askJSON<T>(
  apiKey: string,
  model: string,
  prompt: string,
  system: string
): Promise<T> {
  const m = client(apiKey).getGenerativeModel({
    model: model || DEFAULT_MODEL,
    systemInstruction: system,
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const res = await m.generateContent(prompt);
  const text = res.response.text().trim();
  const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(clean) as T;
}

function evidenceBlock(parsed: ParseResult): string {
  const faultLines = parsed.faults
    .map(
      (f, i) =>
        `Fault ${i + 1}: type=${f.faultType}` +
        (f.reasonCode !== null ? ` reason=${f.reasonCode} (${f.reasonText})` : "") +
        (f.faultingPc ? ` faultingPC=${f.faultingPc}` : "") +
        (f.currentThread ? ` thread=${f.currentThread}` : "") +
        (f.detail.length ? `\n  detail: ${f.detail.join(" | ")}` : "")
    )
    .join("\n");
  const asserts = parsed.assertions
    .map((a) => `Assertion: [${a.expression}] @ ${a.file}:${a.line}`)
    .join("\n");
  const regs = parsed.registers.map((r) => `${r.name}=${r.value}`).join(", ");
  return [
    `Parser summary: ${parsed.summary}`,
    faultLines && `Faults:\n${faultLines}`,
    asserts && `Assertions:\n${asserts}`,
    regs && `Registers: ${regs}`,
    parsed.droppedMessages ? `Dropped log messages: ${parsed.droppedMessages}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface TriageResult {
  category: string; // e.g. "Stack overflow", "NULL pointer dereference"
  confidence: number; // 0..1
  rationale: string;
}

export async function triage(apiKey: string, model: string, parsed: ParseResult): Promise<TriageResult> {
  const system =
    "You are a Zephyr RTOS fault triage expert. Classify the failure from parsed evidence only. " +
    "Do not invent register values or facts not present. Respond as JSON with keys: category, confidence (0-1), rationale.";
  const prompt = `Parsed evidence from the Zephyr log:\n\n${evidenceBlock(parsed)}\n\nClassify the most likely failure category.`;
  return askJSON<TriageResult>(apiKey, model, prompt, system);
}

export interface EvidenceCitation {
  claim: string;
  source: "log" | "datasheet" | "zephyr-docs";
  ref: string; // log line text, datasheet snippet, or doc reference
}

export interface DiagnosisResult {
  rootCause: string;
  evidence: EvidenceCitation[];
  fix: {
    kind: "kconfig" | "devicetree" | "code" | "investigation";
    title: string;
    content: string; // the actual snippet / commands
    explanation: string;
  };
  alternatives: string[];
}

export async function diagnose(
  apiKey: string,
  model: string,
  parsed: ParseResult,
  triageResult: TriageResult,
  datasheetText: string
): Promise<DiagnosisResult> {
  const system =
    "You are a senior Zephyr RTOS firmware engineer. Produce a grounded root-cause analysis and a concrete fix. " +
    "Rules: (1) Every claim in `evidence` must cite a real log line, a datasheet passage, or Zephyr docs — never fabricate. " +
    "(2) The fix must be a real Zephyr artifact: a Kconfig change (prj.conf), a devicetree overlay, or a code patch. " +
    "(3) If evidence is insufficient, set fix.kind to 'investigation' and give the exact commands to gather more (e.g. addr2line, CONFIG_THREAD_ANALYZER). " +
    "Respond as JSON: { rootCause, evidence:[{claim, source, ref}], fix:{kind, title, content, explanation}, alternatives:[string] }.";
  const prompt = [
    `Triage: ${triageResult.category} (confidence ${triageResult.confidence}). ${triageResult.rationale}`,
    `Parsed evidence:\n${evidenceBlock(parsed)}`,
    datasheetText.trim()
      ? `Datasheet excerpt (use for memory map, registers, clocks, IRQ numbers; cite as source "datasheet"):\n${datasheetText.slice(0, 12000)}`
      : "No datasheet provided.",
    `Grounding knowledge (Zephyr documented behavior):\n${knowledgeContext()}`,
  ].join("\n\n---\n\n");
  return askJSON<DiagnosisResult>(apiKey, model, prompt, system);
}

export interface CriticResult {
  verdict: "supported" | "needs-more-evidence" | "speculative";
  confidence: number;
  caveats: string[];
  agree: boolean;
}

export async function critic(
  apiKey: string,
  model: string,
  parsed: ParseResult,
  diagnosis: DiagnosisResult
): Promise<CriticResult> {
  const system =
    "You are a skeptical reviewer. Check whether the proposed fix is actually supported by the parsed log evidence. " +
    "Be honest: if the diagnosis leaps beyond the evidence, say so. " +
    "Respond as JSON: { verdict: 'supported'|'needs-more-evidence'|'speculative', confidence (0-1), caveats:[string], agree:boolean }.";
  const prompt = [
    `Parsed evidence:\n${evidenceBlock(parsed)}`,
    `Proposed root cause: ${diagnosis.rootCause}`,
    `Proposed fix (${diagnosis.fix.kind}): ${diagnosis.fix.title}\n${diagnosis.fix.content}`,
    `Cited evidence: ${diagnosis.evidence.map((e) => `[${e.source}] ${e.claim}`).join(" | ")}`,
  ].join("\n\n");
  return askJSON<CriticResult>(apiKey, model, prompt, system);
}

// Follow-up Q&A over the same context (the "Q&A assistant" part of the theme).
export async function followUp(
  apiKey: string,
  model: string,
  question: string,
  parsed: ParseResult,
  diagnosis: DiagnosisResult,
  datasheetText: string
): Promise<string> {
  const m = client(apiKey).getGenerativeModel({
    model: model || DEFAULT_MODEL,
    systemInstruction:
      "You are a Zephyr RTOS expert answering a follow-up about a specific diagnosed fault. " +
      "Stay grounded in the evidence and the diagnosis. If you don't know, say so and suggest how to find out.",
    generationConfig: { temperature: 0.3 },
  });
  const prompt = [
    `Evidence:\n${evidenceBlock(parsed)}`,
    `Diagnosis: ${diagnosis.rootCause}`,
    `Fix: ${diagnosis.fix.title} — ${diagnosis.fix.content}`,
    datasheetText.trim() ? `Datasheet excerpt:\n${datasheetText.slice(0, 8000)}` : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const res = await m.generateContent(prompt);
  return res.response.text();
}
