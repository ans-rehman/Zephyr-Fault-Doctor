import { NextRequest } from "next/server";
import { parseZephyrLog } from "@/lib/zephyrParser";
import { followUp, DiagnosisResult } from "@/lib/agents";
import { Provider } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { question, log, datasheet, diagnosis, apiKey, model, provider } = (await req.json()) as {
    question: string;
    log: string;
    datasheet?: string;
    diagnosis: DiagnosisResult;
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
  try {
    const parsed = parseZephyrLog(log || "");
    const answer = await followUp(provider, apiKey, model || "", question, parsed, diagnosis, datasheet || "");
    return new Response(JSON.stringify({ answer }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
