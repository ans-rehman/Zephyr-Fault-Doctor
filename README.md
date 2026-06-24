# Zephyr Fault Doctor

An **agentic multi-document diagnosis assistant for [Zephyr RTOS](https://www.zephyrproject.org/)**.
Paste a Zephyr console log (and optionally a SoC/board datasheet); a chain of agents
parses the fault, classifies it, produces a **grounded root cause with citations**, and
emits a **concrete fix** — a `prj.conf` change, a devicetree overlay, or a code patch —
which a critic agent then checks against the evidence. You can ask follow-up questions
about the diagnosis.

## Why it isn't just a chatbot

A general LLM will read a log and *guess*. This pins the answer to reality:

1. **Deterministic parser first.** `lib/zephyrParser.ts` extracts fault type, Zephyr
   `FATAL ERROR` reason codes, faulting PC, registers, current thread, and assertions
   with regex — no model involved. The LLM reasons over *parsed facts*, not raw text.
2. **Grounded diagnosis.** `lib/zephyrKnowledge.ts` injects documented Zephyr fault
   behavior and fix levers, so the model cites real Kconfig symbols and Zephyr docs
   instead of inventing them.
3. **A critic gate.** Every fix is reviewed against the evidence and labeled
   *supported / needs-more-evidence / speculative*. It is allowed to say "not enough
   evidence" — which is the honest answer a confident chatbot won't give.
4. **Token-smart context.** Rather than dumping a whole datasheet into the prompt,
   `lib/relevance.ts` cleans, chunks, and selects only the fault-relevant sections, and
   only the matching Zephyr knowledge entries are included. Big manuals stay cheap.

## Agent pipeline

```
log ──> [parse + datasheet trim] ──> [analyze] ──> report ──> [follow-up Q&A]
        (regex, local, 0 tokens)     (1 LLM call:
                                       triage + diagnose + critic)
```

The parse stage is pure local code (regex extraction + relevance trimming, no tokens).
The triage, diagnosis, and critic roles are then performed in a **single grounded LLM
call** — collapsing three requests into one keeps usage inside free-tier rate limits.
Each stage still streams to the UI as it resolves (NDJSON), so the agentic workflow is
visible while it runs.

## Token efficiency

LLM cost here is dominated by datasheet text, so the app minimizes it locally before any
request is sent (`lib/relevance.ts`):

- **Clean** — collapse whitespace and strip repeated page headers/footers.
- **Chunk + select** — score paragraphs against the actual fault (registers like BFAR/CFSR,
  terms like "stack"/"NVIC"/"memory map"; fault-specific terms weighted 3×, generic anchors
  1×, repetition capped so filler can't win), and send only the top sections (~4k chars).
- **Targeted grounding** — include only the Zephyr knowledge entries matching the fault,
  not all of them.

In a test this trimmed a 16,559-character datasheet to 267 characters of exactly the
relevant sections (memory map, BFAR/CFSR, NVIC) — roughly 4,000 tokens saved on a single
run, far more on a multi-hundred-page manual. The UI shows the saving live
(`datasheet trimmed 16,559 → 267 chars · ~4,000 tokens saved`).

## Stack

- Next.js 14 (App Router) — deployed on Vercel
- Gemini / OpenAI / Anthropic via a uniform REST adapter (`lib/providers.ts`)
- `pdfjs-dist` for client-side datasheet text extraction
- Tailwind CSS

## Bring your own key — any of three providers

The app ships with **no API keys**. The user picks a provider from a dropdown and
pastes their own key:

| Provider | Key prefix | Get a key |
|---|---|---|
| Google Gemini | `AIza…` | https://aistudio.google.com/apikey |
| OpenAI (ChatGPT) | `sk-…` | https://platform.openai.com/api-keys |
| Anthropic (Claude) | `sk-ant-…` | https://console.anthropic.com/settings/keys |

The key is verified live (a green "connected" dot plus the list of usable models for
that key), stored only in that browser's `localStorage` per provider, and sent straight
to the chosen provider per request. The whole agent pipeline is provider-agnostic — a
single `lib/providers.ts` adapter normalizes each API so the rest of the app doesn't
care which model answered. Gemini is the default (this is a Google ecosystem build);
OpenAI and Claude are fallbacks, handy when a user has no Gemini quota.

## Run locally

```bash
npm install
npm run dev                     # http://localhost:3000, then paste your key in the UI
```

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel.
3. No environment variables required — users bring their own keys in the UI.
4. Deploy. The API routes run on the Node.js runtime (`maxDuration = 60`).

## Try it

Click **sample** in the log panel, or load any file from `public/samples/`
(`stack_overflow.log`, `null_deref.log`, `assert_isr.log`), then **Diagnose fault**.

## Roadmap

- `addr2line` integration to symbolize the faulting PC against an uploaded `.elf`
- Live Zephyr-docs grounding via Gemini + Google Search
- Multi-log correlation across reboots
