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

## Agent pipeline

```
log ──> [parse] ──> [triage] ──> [diagnose + fix] ──> [critic] ──> report ──> [follow-up Q&A]
        (regex)     (Gemini)     (Gemini, grounded)   (Gemini)
```

Each stage streams to the UI as it completes (NDJSON), so the agentic workflow is
visible while it runs.

## Stack

- Next.js 14 (App Router) — deployed on Vercel
- Google Gemini via `@google/generative-ai`
- `pdfjs-dist` for client-side datasheet text extraction
- Tailwind CSS

## Bring your own key

The app does **not** ship with an API key. Each user pastes their own Gemini key into
the key field in the UI; the app verifies it live (a green "connected" dot, with the
list of usable models), stores it only in that browser's `localStorage`, and sends it
straight to Gemini per request. Nothing is billed to the deployer.

Get a free key at https://aistudio.google.com/apikey.

## Run locally

```bash
npm install
npm run dev                     # http://localhost:3000, then paste your key in the UI
```

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel.
3. No required environment variables (optionally set `GEMINI_MODEL` as a fallback default).
4. Deploy. The API routes run on the Node.js runtime (`maxDuration = 60`).

## Try it

Click **sample** in the log panel, or load any file from `public/samples/`
(`stack_overflow.log`, `null_deref.log`, `assert_isr.log`), then **Diagnose fault**.

## Roadmap

- `addr2line` integration to symbolize the faulting PC against an uploaded `.elf`
- Live Zephyr-docs grounding via Gemini + Google Search
- Multi-log correlation across reboots
