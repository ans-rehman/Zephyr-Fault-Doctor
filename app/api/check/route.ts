import { NextRequest } from "next/server";
import { listModels, Provider } from "@/lib/providers";

export const runtime = "nodejs";

// Validates a key for the chosen provider by listing its models (no token cost)
// and returns the chat models usable with that key.
export async function POST(req: NextRequest) {
  const { provider, apiKey } = (await req.json()) as { provider: Provider; apiKey: string };
  if (!apiKey || !apiKey.trim()) {
    return Response.json({ ok: false, error: "Enter an API key." }, { status: 400 });
  }
  try {
    const models = await listModels(provider, apiKey);
    return Response.json({ ok: true, provider, models });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Could not reach the provider.";
    return Response.json({ ok: false, error: msg }, { status: 200 });
  }
}
