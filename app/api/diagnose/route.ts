import { NextRequest } from "next/server";
import { parseZephyrLog } from "@/lib/zephyrParser";
import { analyze } from "@/lib/agents";
import { selectRelevantDatasheet } from "@/lib/relevance";
import { Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const { log, datasheet, apiKey, model, provider } = (await req.json()) as {
    log: string;
    datasheet?: string;
    apiKey?: string;
    model?: string;
    provider: Provider;
  };

  if (!apiKey || !apiKey.trim()) {
    return new Response(JSON.stringify({ error: "Add your API key first." }), {
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

        // Trim the datasheet locally to only fault-relevant sections (saves tokens)
        const trim = selectRelevantDatasheet(datasheet || "", parsed, 4000);

        send({ type: "step", id: "parse", status: "done", data: {
          summary: parsed.summary,
          faults: parsed.faults,
          assertions: parsed.assertions,
          registers: parsed.registers,
          counts: parsed.counts,
          context: datasheet
            ? {
                originalChars: trim.originalChars,
                selectedChars: trim.selectedChars,
                tokensSaved: trim.tokensSaved,
              }
            : null,
        }});

        if (!parsed.hasFatal && parsed.counts.warn === 0) {
          send({ type: "result", report: {
            note: "No Zephyr fault signature found. This log looks clean — paste the log around the crash/reboot.",
            parsed,
          }});
          controller.close();
          return;
        }

        // Stage 2-4 — one grounded call performs triage + diagnosis + critic
        // (collapsed into a single request to stay within free-tier limits).
        send({ type: "step", id: "triage", status: "running" });
        const a = await analyze(provider, apiKey, model || "", parsed, trim.selected);
        send({ type: "step", id: "triage", status: "done", data: a.triage });

        await tick(250);
        send({ type: "step", id: "diagnose", status: "running" });
        await tick(150);
        send({ type: "step", id: "diagnose", status: "done", data: a.diagnosis });

        await tick(150);
        send({ type: "step", id: "critic", status: "running" });
        await tick(150);
        send({ type: "step", id: "critic", status: "done", data: a.critic });

        send({ type: "result", report: { parsed, triage: a.triage, diagnosis: a.diagnosis, critic: a.critic } });
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
