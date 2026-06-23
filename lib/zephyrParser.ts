// Deterministic Zephyr RTOS console-log parser.
// Extracts structured fault evidence BEFORE the LLM sees anything, so the
// diagnosis is grounded in real parsed events rather than the model's guesses.

export type Severity = "fatal" | "warn" | "info";

export interface ParsedRegister {
  name: string;
  value: string;
}

export interface ZephyrFault {
  // e.g. "USAGE FAULT", "MPU FAULT", "BUS FAULT", "HARD FAULT", "Stack overflow"
  faultType: string;
  // Zephyr "ZEPHYR FATAL ERROR N: ..." reason code + text, when present
  reasonCode: number | null;
  reasonText: string | null;
  detail: string[]; // sub-lines that describe the fault
  faultingPc: string | null;
  currentThread: string | null;
  rawLines: number[]; // indices into the original line array
}

export interface ZephyrAssertion {
  expression: string;
  file: string;
  line: number;
  raw: number;
}

export interface ParseResult {
  faults: ZephyrFault[];
  assertions: ZephyrAssertion[];
  registers: ParsedRegister[];
  droppedMessages: number;
  counts: { fatal: number; warn: number; info: number };
  lines: { idx: number; severity: Severity; module: string | null; text: string; raw: string }[];
  hasFatal: boolean;
  summary: string;
}

// Strip the Zephyr log prefix: "[00:00:03.123,456] <err> module: message"
const LOG_PREFIX =
  /^\s*(?:\[[\d:.,]+\]\s*)?<(err|wrn|inf|dbg)>\s*(?:([\w./-]+):\s*)?(.*)$/;

const FAULT_MARKERS: { re: RegExp; type: string }[] = [
  { re: /\*{3,}\s*USAGE FAULT\s*\*{3,}/i, type: "USAGE FAULT" },
  { re: /\*{3,}\s*MPU FAULT\s*\*{3,}/i, type: "MPU FAULT" },
  { re: /\*{3,}\s*BUS FAULT\s*\*{3,}/i, type: "BUS FAULT" },
  { re: /\*{3,}\s*MEM(?:ORY)? MANAGE FAULT\s*\*{3,}/i, type: "MEM MANAGE FAULT" },
  { re: /\*{3,}\s*HARD FAULT\s*\*{3,}/i, type: "HARD FAULT" },
  { re: /\*{3,}\s*Stack overflow\s*\*{3,}/i, type: "Stack overflow" },
  { re: /\*{3,}\s*Data Access Violation\s*\*{3,}/i, type: "Data Access Violation" },
  { re: /\*{3,}\s*Instruction Access Violation\s*\*{3,}/i, type: "Instruction Access Violation" },
];

const REASON_RE = /ZEPHYR FATAL ERROR\s+(\d+)\s*:\s*(.+?)\s*(?:on CPU.*)?$/i;
const PC_RE = /Faulting instruction address.*?:\s*(0x[0-9a-fA-F]+)/;
const THREAD_RE = /Current thread:\s*(0x[0-9a-fA-F]+\s*\(?[^)]*\)?)/;
const REG_RE = /\b(r\d{1,2}\/?\w*|lr|pc|xpsr|msp|psp|sp|fault|bfar|mmfar|cfsr|hfsr)\s*[:=]\s*(0x[0-9a-fA-F]+)/gi;
const ASSERT_RE = /ASSERTION FAIL\s*\[([^\]]*)\]\s*@\s*(.+?):(\d+)/i;
const DROPPED_RE = /---\s*(\d+)\s*messages? dropped\s*---/i;

export function parseZephyrLog(raw: string): ParseResult {
  const rawLines = raw.replace(/\r\n/g, "\n").split("\n");
  const lines: ParseResult["lines"] = [];
  const faults: ZephyrFault[] = [];
  const assertions: ZephyrAssertion[] = [];
  const registers: ParsedRegister[] = [];
  let droppedMessages = 0;
  const counts = { fatal: 0, warn: 0, info: 0 };

  let activeFault: ZephyrFault | null = null;

  rawLines.forEach((rawLine, idx) => {
    if (!rawLine.trim()) return;

    const m = rawLine.match(LOG_PREFIX);
    const levelMap: Record<string, Severity> = {
      err: "fatal",
      wrn: "warn",
      inf: "info",
      dbg: "info",
    };
    const severity: Severity = m ? levelMap[m[1]] : "info";
    const module = m ? m[2] ?? null : null;
    const text = m ? m[3] : rawLine.trim();

    if (severity === "fatal") counts.fatal++;
    else if (severity === "warn") counts.warn++;
    else counts.info++;

    lines.push({ idx, severity, module, text, raw: rawLine });

    // Dropped logs
    const dropped = text.match(DROPPED_RE);
    if (dropped) droppedMessages += parseInt(dropped[1], 10);

    // Assertions (can appear without the fatal-fault banner)
    const assertMatch = text.match(ASSERT_RE);
    if (assertMatch) {
      assertions.push({
        expression: assertMatch[1].trim(),
        file: assertMatch[2].trim(),
        line: parseInt(assertMatch[3], 10),
        raw: idx,
      });
    }

    // Fault banner -> open a new fault block
    const marker = FAULT_MARKERS.find((fm) => fm.re.test(text));
    if (marker) {
      activeFault = {
        faultType: marker.type,
        reasonCode: null,
        reasonText: null,
        detail: [],
        faultingPc: null,
        currentThread: null,
        rawLines: [idx],
      };
      faults.push(activeFault);
      return;
    }

    // ZEPHYR FATAL ERROR N: ... (may open a block if no marker preceded it)
    const reason = text.match(REASON_RE);
    if (reason) {
      if (!activeFault) {
        activeFault = {
          faultType: reason[2].trim(),
          reasonCode: parseInt(reason[1], 10),
          reasonText: reason[2].trim(),
          detail: [],
          faultingPc: null,
          currentThread: null,
          rawLines: [idx],
        };
        faults.push(activeFault);
      } else {
        activeFault.reasonCode = parseInt(reason[1], 10);
        activeFault.reasonText = reason[2].trim();
        activeFault.rawLines.push(idx);
      }
      return;
    }

    // Enrich the currently-open fault block
    if (activeFault) {
      const pc = text.match(PC_RE);
      if (pc) activeFault.faultingPc = pc[1];

      const th = text.match(THREAD_RE);
      if (th) activeFault.currentThread = th[1].trim();

      let regMatch: RegExpExecArray | null;
      REG_RE.lastIndex = 0;
      while ((regMatch = REG_RE.exec(text)) !== null) {
        registers.push({ name: regMatch[1], value: regMatch[2] });
      }

      // close the block on "Halting system" / "Rebooting"
      if (/Halting system|Resetting system|reboot|RUNNING\b/i.test(text)) {
        activeFault.detail.push(text);
        activeFault.rawLines.push(idx);
        activeFault = null;
      } else if (severity === "fatal") {
        activeFault.detail.push(text);
        activeFault.rawLines.push(idx);
      }
    }
  });

  const hasFatal = faults.length > 0 || assertions.length > 0;

  const parts: string[] = [];
  if (faults.length) {
    parts.push(
      faults
        .map(
          (f) =>
            f.faultType +
            (f.reasonText && f.reasonText !== f.faultType ? ` (${f.reasonText})` : "")
        )
        .join(", ")
    );
  }
  if (assertions.length) parts.push(`${assertions.length} assertion failure(s)`);
  if (!hasFatal && counts.warn) parts.push(`${counts.warn} warning(s), no fatal fault`);
  if (droppedMessages) parts.push(`${droppedMessages} dropped log message(s)`);
  const summary = parts.length ? parts.join(" · ") : "No Zephyr fault signature detected in the log.";

  return {
    faults,
    assertions,
    registers,
    droppedMessages,
    counts,
    lines,
    hasFatal,
    summary,
  };
}
