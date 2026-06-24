// Multi-provider LLM layer. The provider is chosen explicitly in the UI and
// passed through; we expose uniform callJSON / callText so the agent pipeline
// is provider-agnostic. All calls run server-side (no CORS concerns).

export type Provider = "gemini" | "openai" | "anthropic";

export const PROVIDERS: { id: Provider; label: string; keyHint: string; keysUrl: string }[] = [
  { id: "gemini", label: "Google Gemini", keyHint: "AIza…", keysUrl: "https://aistudio.google.com/apikey" },
  { id: "openai", label: "OpenAI (ChatGPT)", keyHint: "sk-…", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-…", keysUrl: "https://console.anthropic.com/settings/keys" },
];

export function providerLabel(p: Provider): string {
  return PROVIDERS.find((x) => x.id === p)?.label ?? p;
}

const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isQuota(msg: string): boolean {
  return /429|quota|RESOURCE_EXHAUSTED|rate.?limit|insufficient_quota|overloaded/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isQuota(msg) && attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      if (isQuota(msg)) {
        throw new Error(
          "Provider quota/rate limit hit. Wait ~30s and retry, switch to a cheaper/faster model in the picker, " +
            "or check that your key still has credits/quota."
        );
      }
      throw err;
    }
  }
}

async function errText(r: Response, fallback: string): Promise<string> {
  const body = await r.json().catch(() => ({} as any));
  return (
    body?.error?.message ||
    (r.status === 401 || r.status === 403 ? fallback : `HTTP ${r.status}`)
  );
}

// ---- validation + model listing ----

export async function listModels(provider: Provider, apiKey: string): Promise<string[]> {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("Enter an API key.");

  if (provider === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    );
    if (!r.ok) throw new Error(await errText(r, "Invalid or unauthorized Gemini key."));
    const data = (await r.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    return (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /gemini/i.test(n));
  }

  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(await errText(r, "Invalid or unauthorized OpenAI key."));
    const data = (await r.json()) as { data?: { id: string }[] };
    return (data.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id))
      .filter((id) => !/(embedding|whisper|tts|dall-e|dalle|image|audio|realtime|moderation|transcribe|search)/i.test(id))
      .sort();
  }

  // anthropic
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!r.ok) throw new Error(await errText(r, "Invalid or unauthorized Anthropic key."));
  const data = (await r.json()) as { data?: { id: string }[] };
  return (data.data || []).map((m) => m.id).filter((id) => /claude/i.test(id));
}

// ---- generation ----

async function generate(
  provider: Provider,
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  wantJSON: boolean
): Promise<string> {
  const key = (apiKey || "").trim();
  const m = model || DEFAULT_MODEL[provider];

  if (provider === "gemini") {
    return withRetry(async () => {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              ...(wantJSON ? { responseMimeType: "application/json" } : {}),
            },
          }),
        }
      );
      if (!r.ok) throw new Error(await errText(r, "Gemini request failed."));
      const data = await r.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    });
  }

  if (provider === "openai") {
    return withRetry(async () => {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          ...(wantJSON ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (!r.ok) throw new Error(await errText(r, "OpenAI request failed."));
      const data = await r.json();
      return data?.choices?.[0]?.message?.content ?? "";
    });
  }

  // anthropic — force JSON via assistant prefill "{"
  return withRetry(async () => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 4096,
        system,
        messages: wantJSON
          ? [
              { role: "user", content: prompt },
              { role: "assistant", content: "{" },
            ]
          : [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(await errText(r, "Anthropic request failed."));
    const data = await r.json();
    const text = data?.content?.[0]?.text ?? "";
    return wantJSON ? "{" + text : text;
  });
}

function cleanJSON(text: string): string {
  return text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

export async function callJSON<T>(
  provider: Provider,
  apiKey: string,
  model: string,
  system: string,
  prompt: string
): Promise<T> {
  const text = await generate(provider, apiKey, model, system, prompt, true);
  return JSON.parse(cleanJSON(text)) as T;
}

export async function callText(
  provider: Provider,
  apiKey: string,
  model: string,
  system: string,
  prompt: string
): Promise<string> {
  return generate(provider, apiKey, model, system, prompt, false);
}
