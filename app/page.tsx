"use client";

import { useEffect, useRef, useState } from "react";

type StepId = "parse" | "triage" | "diagnose" | "critic";
type Status = "idle" | "running" | "done";

interface StepState {
  status: Status;
  data?: any;
}

const STEP_META: { id: StepId; label: string; note: string }[] = [
  { id: "parse", label: "Parse log", note: "Extract fault events deterministically" },
  { id: "triage", label: "Triage", note: "Classify the failure" },
  { id: "diagnose", label: "Diagnose + fix", note: "Grounded root cause & patch" },
  { id: "critic", label: "Critic", note: "Gate the fix against evidence" },
];

const SAMPLE_LOG = `*** Booting Zephyr OS build v3.6.0 ***
[00:00:00.001,000] <inf> main: app started
[00:00:02.412,000] <err> os: ***** MPU FAULT *****
[00:00:02.412,000] <err> os:   Stacking error (context area might be not valid)
[00:00:02.412,000] <err> os: r0/a1:  0x20000a18  r1/a2:  0x00000050  r2/a3:  0x00000000
[00:00:02.412,000] <err> os: r12/ip: 0x00000000  lr:     0x08001a23
[00:00:02.412,000] <err> os: Faulting instruction address (r15/pc): 0x08001a40
[00:00:02.412,000] <err> os: >>> ZEPHYR FATAL ERROR 2: Stack overflow on CPU 0
[00:00:02.412,000] <err> os: Current thread: 0x20000200 (sensor_wq)
[00:00:02.412,000] <err> os: Halting system`;

async function extractPdfText(file: File): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let out = "";
  const pages = Math.min(doc.numPages, 30);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it: any) => it.str).join(" ") + "\n";
  }
  return out;
}

function Badge({ verdict }: { verdict?: string }) {
  const map: Record<string, { c: string; t: string }> = {
    supported: { c: "text-ok border-ok/40 bg-ok/10", t: "Evidence-supported" },
    "needs-more-evidence": { c: "text-warn border-warn/40 bg-warn/10", t: "Needs more evidence" },
    speculative: { c: "text-fatal border-fatal/40 bg-fatal/10", t: "Speculative" },
  };
  const m = map[verdict || ""] || { c: "text-muted border-line", t: verdict || "—" };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${m.c} font-mono`}>{m.t}</span>
  );
}

export default function Home() {
  // Bring-your-own Gemini key (stored only in this browser)
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [conn, setConn] = useState<{ status: "idle" | "checking" | "ok" | "error"; msg?: string }>({
    status: "idle",
  });

  const [log, setLog] = useState("");
  const [datasheet, setDatasheet] = useState("");
  const [datasheetName, setDatasheetName] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<StepId, StepState>>({
    parse: { status: "idle" },
    triage: { status: "idle" },
    diagnose: { status: "idle" },
    critic: { status: "idle" },
  });
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState("");

  // follow-up Q&A
  const [qa, setQa] = useState<{ q: string; a: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  // Validate the key against Gemini (lists models — no token cost)
  async function checkKey(key: string) {
    if (!key.trim()) {
      setConn({ status: "idle" });
      return;
    }
    setConn({ status: "checking" });
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (data.ok) {
        const list: string[] = data.models || [];
        setModels(list);
        setModel((cur) => {
          if (cur && list.includes(cur)) return cur;
          const flash =
            list.find((m) => /flash/i.test(m) && !/(thinking|exp|preview|lite)/i.test(m)) ||
            list.find((m) => /flash/i.test(m)) ||
            list[0] ||
            "";
          return flash;
        });
        setConn({ status: "ok" });
      } else {
        setConn({ status: "error", msg: data.error || "Key check failed." });
      }
    } catch (e: any) {
      setConn({ status: "error", msg: e?.message || "Could not reach the server." });
    }
  }

  // Load saved key/model on mount and auto-verify
  useEffect(() => {
    if (typeof window === "undefined") return;
    const k = window.localStorage.getItem("zfd_key") || "";
    const m = window.localStorage.getItem("zfd_model") || "";
    if (m) setModel(m);
    if (k) {
      setApiKey(k);
      checkKey(k);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (model && typeof window !== "undefined") window.localStorage.setItem("zfd_model", model);
  }, [model]);

  function onKeyChange(v: string) {
    setApiKey(v);
    setConn({ status: "idle" });
    if (typeof window !== "undefined") window.localStorage.setItem("zfd_key", v);
  }

  function reset() {
    setSteps({
      parse: { status: "idle" },
      triage: { status: "idle" },
      diagnose: { status: "idle" },
      critic: { status: "idle" },
    });
    setReport(null);
    setError("");
    setQa([]);
  }

  async function onDatasheet(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDatasheetName(file.name);
    if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
      setDatasheet("Extracting…");
      try {
        setDatasheet(await extractPdfText(file));
      } catch {
        setDatasheet("");
        setDatasheetName(file.name + " (could not read — paste text instead)");
      }
    } else {
      setDatasheet(await file.text());
    }
  }

  async function onLogFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLog(await file.text());
  }

  async function run() {
    if (!apiKey.trim()) {
      setError("Add your Gemini API key first.");
      return;
    }
    if (!log.trim()) {
      setError("Paste or upload a Zephyr log first.");
      return;
    }
    reset();
    setRunning(true);
    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ log, datasheet, apiKey, model }),
      });
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "step") {
            setSteps((s) => ({ ...s, [ev.id]: { status: ev.status, data: ev.data ?? s[ev.id as StepId].data } }));
          } else if (ev.type === "result") {
            setReport(ev.report);
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        }
      }
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  async function ask() {
    if (!question.trim() || !report?.diagnosis) return;
    const q = question;
    setQuestion("");
    setAsking(true);
    setQa((prev) => [...prev, { q, a: "" }]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, log, datasheet, diagnosis: report.diagnosis, apiKey, model }),
      });
      const data = await res.json();
      setQa((prev) =>
        prev.map((item, i) => (i === prev.length - 1 ? { ...item, a: data.answer || data.error } : item))
      );
    } catch {
      setQa((prev) => prev.map((item, i) => (i === prev.length - 1 ? { ...item, a: "Failed to answer." } : item)));
    } finally {
      setAsking(false);
    }
  }

  const d = report?.diagnosis;
  const c = report?.critic;
  const t = report?.triage;

  return (
    <div className="min-h-screen bg-base">
      {/* Header */}
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-5 py-4 flex items-center gap-3">
          <div className="relative w-7 h-7 rounded-md bg-panel2 border border-line overflow-hidden grid place-items-center">
            <span className="text-trace text-sm font-mono">⌁</span>
          </div>
          <div>
            <h1 className="font-mono text-ink text-[15px] tracking-tight">zephyr<span className="text-trace">·</span>fault-doctor</h1>
            <p className="text-faint text-[11px] -mt-0.5">agentic fault diagnosis for Zephyr RTOS</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 grid lg:grid-cols-[360px_1fr] gap-6">
        {/* SOURCES PANEL */}
        <section className="space-y-4">
          {/* API KEY + CONNECTION */}
          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs uppercase tracking-wider text-muted">Gemini API key</h2>
              <span className="flex items-center gap-1.5 text-[11px] font-mono">
                <span
                  className={`w-2 h-2 rounded-full ${
                    conn.status === "ok"
                      ? "bg-ok"
                      : conn.status === "checking"
                      ? "bg-trace animate-pulseDot"
                      : conn.status === "error"
                      ? "bg-fatal"
                      : "bg-faint"
                  }`}
                />
                <span
                  className={
                    conn.status === "ok"
                      ? "text-ok"
                      : conn.status === "error"
                      ? "text-fatal"
                      : "text-muted"
                  }
                >
                  {conn.status === "ok"
                    ? "connected"
                    : conn.status === "checking"
                    ? "checking…"
                    : conn.status === "error"
                    ? "not connected"
                    : "not tested"}
                </span>
              </span>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => onKeyChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && checkKey(apiKey)}
                  placeholder="AIza…"
                  spellCheck={false}
                  className="w-full bg-base border border-line rounded-lg pl-3 pr-12 py-2 font-mono text-[12px] outline-none focus:border-trace/50"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-faint hover:text-ink"
                >
                  {showKey ? "hide" : "show"}
                </button>
              </div>
              <button
                onClick={() => checkKey(apiKey)}
                disabled={conn.status === "checking" || !apiKey.trim()}
                className="px-3 rounded-lg border border-line text-trace text-sm hover:bg-trace/10 disabled:opacity-40"
              >
                test
              </button>
            </div>
            {conn.status === "error" && conn.msg && (
              <p className="text-fatal text-[11px] mt-1.5">{conn.msg}</p>
            )}
            {conn.status === "ok" && models.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <label className="text-[11px] text-muted">model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="flex-1 bg-base border border-line rounded-lg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-trace/50"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="text-faint text-[10px] mt-2">
              Your key stays in this browser and is sent only to Gemini.{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-trace hover:underline"
              >
                Get a free key
              </a>
            </p>
          </div>

          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs uppercase tracking-wider text-muted">Console log</h2>
              <div className="flex gap-2">
                <label className="text-[11px] text-trace cursor-pointer hover:underline">
                  upload
                  <input type="file" accept=".log,.txt,text/plain" onChange={onLogFile} className="hidden" />
                </label>
                <button onClick={() => setLog(SAMPLE_LOG)} className="text-[11px] text-muted hover:text-ink">
                  sample
                </button>
              </div>
            </div>
            <textarea
              value={log}
              onChange={(e) => setLog(e.target.value)}
              placeholder="Paste the Zephyr console output around the crash…"
              spellCheck={false}
              className="w-full h-56 bg-base border border-line rounded-lg p-3 font-mono text-[12px] leading-relaxed text-ink resize-none outline-none focus:border-trace/50"
            />
          </div>

          <div className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs uppercase tracking-wider text-muted">Datasheet <span className="text-faint normal-case tracking-normal">(optional)</span></h2>
              <label className="text-[11px] text-trace cursor-pointer hover:underline">
                upload pdf/txt
                <input type="file" accept=".pdf,.txt,application/pdf,text/plain" onChange={onDatasheet} className="hidden" />
              </label>
            </div>
            {datasheetName ? (
              <p className="text-[12px] text-ink font-mono truncate">📄 {datasheetName}</p>
            ) : (
              <p className="text-[12px] text-faint">SoC / board datasheet for memory-map, register and IRQ grounding.</p>
            )}
          </div>

          <button
            onClick={run}
            disabled={running || !apiKey.trim()}
            className="w-full rounded-lg bg-trace text-base font-medium py-2.5 text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {running ? "Diagnosing…" : "Diagnose fault"}
          </button>
          {error && <p className="text-fatal text-[12px]">{error}</p>}
        </section>

        {/* REPORT PANEL */}
        <section className="space-y-5" ref={reportRef}>
          {/* Pipeline — the signature element */}
          <div className="rounded-xl border border-line bg-panel p-4">
            <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Agent pipeline</h2>
            <div className="grid sm:grid-cols-4 gap-2">
              {STEP_META.map((s, i) => {
                const st = steps[s.id].status;
                return (
                  <div
                    key={s.id}
                    className={`relative rounded-lg border p-3 overflow-hidden transition ${
                      st === "done"
                        ? "border-trace/40 bg-trace/5"
                        : st === "running"
                        ? "border-trace/30"
                        : "border-line bg-base/40"
                    }`}
                  >
                    {st === "running" && (
                      <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-trace to-transparent w-1/4 animate-sweep" />
                    )}
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`font-mono text-[10px] ${st === "idle" ? "text-faint" : "text-trace"}`}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {st === "running" && <span className="w-1.5 h-1.5 rounded-full bg-trace animate-pulseDot" />}
                      {st === "done" && <span className="text-trace text-xs">✓</span>}
                    </div>
                    <p className="text-[12px] text-ink leading-tight">{s.label}</p>
                    <p className="text-[10px] text-faint leading-tight mt-0.5">{s.note}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Parsed evidence */}
          {steps.parse.data && (
            <div className="rounded-xl border border-line bg-panel p-4">
              <h2 className="text-xs uppercase tracking-wider text-muted mb-2">Parsed evidence</h2>
              <p className="font-mono text-[12px] text-ink mb-2">{steps.parse.data.summary}</p>
              {steps.parse.data.registers?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {steps.parse.data.registers.slice(0, 12).map((r: any, i: number) => (
                    <span key={i} className="font-mono text-[11px] text-muted border border-line rounded px-1.5 py-0.5">
                      {r.name}={r.value}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-3 text-[11px] font-mono">
                <span className="text-fatal">{steps.parse.data.counts.fatal} err</span>
                <span className="text-warn">{steps.parse.data.counts.warn} wrn</span>
                <span className="text-muted">{steps.parse.data.counts.info} inf</span>
              </div>
            </div>
          )}

          {/* Diagnosis */}
          {d && (
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted mb-1">Root cause</p>
                  <p className="text-ink text-[15px] leading-snug">{d.rootCause}</p>
                </div>
                {c && <Badge verdict={c.verdict} />}
              </div>

              {t && (
                <p className="text-[12px] text-muted">
                  Category: <span className="text-ink">{t.category}</span> · triage confidence{" "}
                  <span className="font-mono">{Math.round((t.confidence || 0) * 100)}%</span>
                </p>
              )}

              {/* Evidence with citations */}
              {d.evidence?.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted mb-2">Evidence</p>
                  <ul className="space-y-1.5">
                    {d.evidence.map((e: any, i: number) => (
                      <li key={i} className="text-[12px] text-ink flex gap-2">
                        <span
                          className={`mt-0.5 shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded border ${
                            e.source === "datasheet"
                              ? "text-warn border-warn/40"
                              : e.source === "zephyr-docs"
                              ? "text-trace border-trace/40"
                              : "text-muted border-line"
                          }`}
                        >
                          {e.source}
                        </span>
                        <span className="leading-snug">
                          {e.claim}
                          {e.ref && <span className="text-faint font-mono"> — {e.ref}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The fix */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] uppercase tracking-wider text-muted">
                    Fix <span className="text-faint normal-case tracking-normal">· {d.fix?.kind}</span>
                  </p>
                  <button
                    onClick={() => navigator.clipboard.writeText(d.fix?.content || "")}
                    className="text-[11px] text-trace hover:underline"
                  >
                    copy
                  </button>
                </div>
                <p className="text-[13px] text-ink mb-2">{d.fix?.title}</p>
                <pre className="bg-base border border-line rounded-lg p-3 font-mono text-[12px] text-ink overflow-x-auto whitespace-pre-wrap">
{d.fix?.content}
                </pre>
                <p className="text-[12px] text-muted mt-2 leading-snug">{d.fix?.explanation}</p>
              </div>

              {/* Critic caveats */}
              {c?.caveats?.length > 0 && (
                <div className="border-t border-line pt-3">
                  <p className="text-[11px] uppercase tracking-wider text-muted mb-1">
                    Critic · confidence <span className="font-mono">{Math.round((c.confidence || 0) * 100)}%</span>
                  </p>
                  <ul className="list-disc list-inside text-[12px] text-muted space-y-0.5">
                    {c.caveats.map((cv: string, i: number) => (
                      <li key={i}>{cv}</li>
                    ))}
                  </ul>
                </div>
              )}

              {d.alternatives?.length > 0 && (
                <details className="text-[12px] text-muted">
                  <summary className="cursor-pointer hover:text-ink">Alternative explanations</summary>
                  <ul className="list-disc list-inside mt-1 space-y-0.5">
                    {d.alternatives.map((a: string, i: number) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Follow-up Q&A */}
          {d && (
            <div className="rounded-xl border border-line bg-panel p-4">
              <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Ask a follow-up</h2>
              <div className="space-y-3 mb-3">
                {qa.map((item, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-[12px] text-trace font-mono">› {item.q}</p>
                    <p className="text-[13px] text-ink whitespace-pre-wrap leading-snug">
                      {item.a || <span className="text-faint">thinking…</span>}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && ask()}
                  placeholder="e.g. how do I confirm which thread overflowed?"
                  className="flex-1 bg-base border border-line rounded-lg px-3 py-2 text-[13px] outline-none focus:border-trace/50"
                />
                <button
                  onClick={ask}
                  disabled={asking}
                  className="px-3 rounded-lg border border-line text-trace text-sm hover:bg-trace/10 disabled:opacity-50"
                >
                  ask
                </button>
              </div>
            </div>
          )}

          {report?.note && !d && (
            <div className="rounded-xl border border-warn/40 bg-warn/5 p-4 text-[13px] text-ink">
              {report.note}
            </div>
          )}

          {!report && !running && (
            <div className="rounded-xl border border-dashed border-line p-10 text-center">
              <p className="text-muted text-sm">Load a Zephyr log and run the pipeline.</p>
              <p className="text-faint text-[12px] mt-1">Try the sample to see a stack-overflow fault diagnosed end to end.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
