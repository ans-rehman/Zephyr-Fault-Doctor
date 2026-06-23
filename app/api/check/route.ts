import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Validates a Gemini API key by listing models (no generation cost) and
// returns the models that support generateContent.
export async function POST(req: NextRequest) {
  const { apiKey } = (await req.json()) as { apiKey: string };
  if (!apiKey || !apiKey.trim()) {
    return Response.json({ ok: false, error: "Enter an API key." }, { status: 400 });
  }
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`,
      { method: "GET" }
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg =
        body?.error?.message ||
        (r.status === 400 || r.status === 403 ? "Invalid or unauthorized API key." : `HTTP ${r.status}`);
      return Response.json({ ok: false, error: msg }, { status: 200 });
    }
    const data = (await r.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      // prefer flash/pro chat models, hide embedding/vision-only helpers
      .filter((n) => /gemini/i.test(n));
    return Response.json({ ok: true, models });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Could not reach Gemini.";
    return Response.json({ ok: false, error: msg }, { status: 200 });
  }
}
