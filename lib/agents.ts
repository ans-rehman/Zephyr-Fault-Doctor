import { ParseResult } from "./zephyrParser";
import { knowledgeContext, selectKnowledge } from "./zephyrKnowledge";
import { callJSON, callText, Provider } from "./providers";

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
  category: string;
  confidence: number;
  rationale: string;
}

export interface EvidenceCitation {
  claim: string;
  source: "log" | "datasheet" | "zephyr-docs";
  ref: string;
}

export interface DiagnosisResult {
  rootCause: string;
  evidence: EvidenceCitation[];
  fix: {
    kind: "kconfig" | "devicetree" | "code" | "investigation";
    title: string;
    content: string;
    explanation: string;
  };
  alternatives: string[];
}

export interface CriticResult {
  verdict: "supported" | "needs-more-evidence" | "speculative";
  confidence: number;
  caveats: string[];
  agree: boolean;
}

export interface AnalysisResult {
  triage: TriageResult;
  diagnosis: DiagnosisResult;
  critic: CriticResult;
}

// One grounded call performs all three roles. Collapsing triage+diagnose+critic
// into a single request keeps usage inside free-tier rate limits.
export async function analyze(
  provider: Provider,
  apiKey: string,
  model: string,
  parsed: ParseResult,
  datasheetText: string
): Promise<AnalysisResult> {
  const system =
    "You are a panel of three Zephyr RTOS experts working a single fault: a TRIAGE engineer, a DIAGNOSIS engineer, and a skeptical CRITIC. " +
    "Reason only from the parsed evidence and the grounding knowledge — never invent register values, APIs, or Kconfig symbols. " +
    "The fix must be a real Zephyr artifact (prj.conf Kconfig, a devicetree overlay, or a code patch); if evidence is thin, set fix.kind='investigation' and give exact commands (addr2line, CONFIG_THREAD_ANALYZER). " +
    "The CRITIC must independently judge whether the fix is supported by the evidence and may disagree. " +
    "Respond with ONLY a JSON object of this exact shape: " +
    '{ "triage": {"category":string,"confidence":number,"rationale":string}, ' +
    '"diagnosis": {"rootCause":string,"evidence":[{"claim":string,"source":"log"|"datasheet"|"zephyr-docs","ref":string}],"fix":{"kind":"kconfig"|"devicetree"|"code"|"investigation","title":string,"content":string,"explanation":string},"alternatives":[string]}, ' +
    '"critic": {"verdict":"supported"|"needs-more-evidence"|"speculative","confidence":number,"caveats":[string],"agree":boolean} }';
  const descriptor = [
    ...parsed.faults.map((f) => `${f.faultType} ${f.reasonText ?? ""}`),
    ...parsed.assertions.map((a) => a.expression),
  ].join(" ");
  const prompt = [
    `Parsed evidence from the Zephyr log:\n${evidenceBlock(parsed)}`,
    datasheetText.trim()
      ? `Relevant datasheet excerpt (memory map, registers, clocks, IRQ numbers; cite as source "datasheet"):\n${datasheetText.slice(0, 6000)}`
      : "No datasheet provided.",
    `Grounding knowledge (documented Zephyr behavior):\n${knowledgeContext(selectKnowledge(descriptor))}`,
  ].join("\n\n---\n\n");
  return callJSON<AnalysisResult>(provider, apiKey, model, system, prompt);
}

// Follow-up Q&A over the same context (the "Q&A assistant" part of the theme).
export async function followUp(
  provider: Provider,
  apiKey: string,
  model: string,
  question: string,
  parsed: ParseResult,
  diagnosis: DiagnosisResult,
  datasheetText: string
): Promise<string> {
  const system =
    "You are a Zephyr RTOS expert answering a follow-up about a specific diagnosed fault. " +
    "Stay grounded in the evidence and the diagnosis. If you don't know, say so and suggest how to find out.";
  const prompt = [
    `Evidence:\n${evidenceBlock(parsed)}`,
    `Diagnosis: ${diagnosis.rootCause}`,
    `Fix: ${diagnosis.fix.title} — ${diagnosis.fix.content}`,
    datasheetText.trim() ? `Datasheet excerpt:\n${datasheetText.slice(0, 8000)}` : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return callText(provider, apiKey, model, system, prompt);
}
