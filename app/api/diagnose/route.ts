import { NextRequest } from "next/server";
import { parseZephyrLog } from "@/lib/zephyrParser";
import { triage, diagnose, critic } from "@/lib/agents";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { log, datasheet, apiKey, model } = (await req.json()) as {
    log: string;
    datasheet?: string;
    apiKey?: string;
    model?: string;
  };

  if (!apiKey || !apiKey.trim()) {
    return new Response(JSON.stringify({ error: "Add your Gemini API key first." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!log || !log.trim()) {
    return new Response(JSON.stringify({ error: "Paste or upload a Zephyr log first." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        // Stage 1 — deterministic parse (no LLM, fully reliable)
        send({ type: "step", id: "parse", status: "running" });
        const parsed = parseZephyrLog(log);
        send({ type: "step", id: "parse", status: "done", data: {
          summary: parsed.summary,
          faults: parsed.faults,
          assertions: parsed.assertions,
          registers: parsed.registers,
          counts: parsed.counts,
        }});

        if (!parsed.hasFatal && parsed.counts.warn === 0) {
          send({ type: "result", report: {
            note: "No Zephyr fault signature found. This log looks clean — paste the log around the crash/reboot.",
            parsed,
          }});
          controller.close();
          return;
        }

        // Stage 2 — triage
        send({ type: "step", id: "triage", status: "running" });
        const t = await triage(apiKey, model || "", parsed);
        send({ type: "step", id: "triage", status: "done", data: t });

        // Stage 3 — diagnose + fix
        send({ type: "step", id: "diagnose", status: "running" });
        const d = await diagnose(apiKey, model || "", parsed, t, datasheet || "");
        send({ type: "step", id: "diagnose", status: "done", data: d });

        // Stage 4 — critic gate
        send({ type: "step", id: "critic", status: "running" });
        const c = await critic(apiKey, model || "", parsed, d);
        send({ type: "step", id: "critic", status: "done", data: c });

        send({ type: "result", report: { parsed, triage: t, diagnosis: d, critic: c } });
        controller.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unexpected error";
        send({ type: "error", message: msg });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
