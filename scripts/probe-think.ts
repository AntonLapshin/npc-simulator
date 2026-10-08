// Exp-7 item A3: A/B probe for LLM_THINK on thinking-class models.
//
// Exp-7 showed ~900-token median completions for ~100-token JSON payloads
// even with LLM_THINK=0 — either think:false never reaches the model on
// this Ollama build, or qwen3 is pathologically verbose. This script sends
// the SAME consequence-shaped JSON prompt twice (think:false vs the flag
// unset) and reports completion tokens + latency + <think> leakage, so the
// verdict is measured, not guessed.
//
// Usage:
//   npx tsx scripts/probe-think.ts [--model qwen3:14b] [--base-url http://127.0.0.1:11434/v1]
//
// Requires a running Ollama with the model pulled.

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const MODEL = opt("--model", process.env["OLLAMA_MODEL"] ?? "qwen3:14b");
const BASE_URL = (opt("--base-url", process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434/v1")).replace(/\/+$/, "");

const SYSTEM = [
  "You are an expert actor. Respond only with valid JSON.",
  "Begin your response with { (the JSON object itself) — never lead with analysis, preamble, or commentary.",
  "Return COMPACT single-line JSON (no pretty-printing, no newlines inside the JSON).",
].join("\n");

// Consequence-shaped prompt: small payload, strict schema — the exp-7 shape.
const USER = [
  "Acting actor: Dana (dana, he/him) at (15, 11), sitting.",
  "Action: Dana stares at his monitor, half-listening to the office.",
  "Recent history: Anton: Anton says, \"Morning, everyone.\"",
  "Output Schema",
  "",
  '{"narrative": "string", "actorPatches": [], "objectPatches": [], "effects": {"moved": false, "spoke": false, "quotedSpeech": []}, "reasoning": "string"}',
  "",
  "EFFECTS: \"moved\" true ONLY for whole-body locomotion; emit x,y IFF moved. \"spoke\" true when words are uttered.",
  "NARRATIVE VOICE: third person, always. Keep Dana's pronouns he/him.",
  "Return JSON only, matching the schema above.",
].join("\n");

type ProbeResult = {
  label: string;
  latencyMs: number;
  completionTokens: number | null;
  promptTokens: number | null;
  thinkLeaked: boolean;
  finishReason: string | null;
  rawLen: number;
};

async function probe(label: string, think: boolean | undefined): Promise<ProbeResult> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ],
    temperature: 0.5,
    max_tokens: 1500,
    response_format: { type: "json_object" },
  };
  if (think !== undefined) body["think"] = think;
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return {
    label,
    latencyMs,
    completionTokens: data.usage?.completion_tokens ?? null,
    promptTokens: data.usage?.prompt_tokens ?? null,
    thinkLeaked: /<think/i.test(content),
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    rawLen: content.length,
  };
}

function verdict(a: ProbeResult, b: ProbeResult): string {
  const lines: string[] = [];
  if (a.completionTokens !== null && b.completionTokens !== null) {
    const ratio = b.completionTokens / Math.max(1, a.completionTokens);
    lines.push(
      `completion tokens: think:false=${a.completionTokens} vs unset=${b.completionTokens} (ratio ${ratio.toFixed(2)}x)`,
    );
    if (ratio > 1.5) {
      lines.push("VERDICT: think:false is NOT effective on this build — the model still emits chain-of-thought against max_tokens. Treat the model as thinking-on: raise budgets or switch the endpoint flag.");
    } else if (b.thinkLeaked && !a.thinkLeaked) {
      lines.push("VERDICT: think:false suppresses <think> leakage but token counts are close — flag is honored, verbosity is the model's own.");
    } else {
      lines.push("VERDICT: think:false is effective — completion volume is comparable; keep LLM_THINK=0.");
    }
  } else {
    lines.push("VERDICT: no usage blocks returned — compare raw lengths manually.");
  }
  if (a.finishReason === "length" || b.finishReason === "length") {
    lines.push("NOTE: finish_reason=length hit — the 1500 budget truncated a tiny JSON payload; this is the exp-7 P3 shape (verbosity, not payload size).");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log(`probe-think: model=${MODEL} base=${BASE_URL}\n`);
  const withFlag = await probe("think:false", false);
  const unset = await probe("think unset", undefined);
  for (const r of [withFlag, unset]) {
    console.log(
      `${r.label}: ${r.latencyMs}ms, completion_tokens=${r.completionTokens ?? "n/a"}, ` +
        `prompt_tokens=${r.promptTokens ?? "n/a"}, finish=${r.finishReason ?? "n/a"}, ` +
        `think_leaked=${r.thinkLeaked}, raw_chars=${r.rawLen}`,
    );
  }
  console.log(`\n${verdict(withFlag, unset)}`);
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Is Ollama running with the model pulled? Start it: npm run setup:ollama");
  process.exitCode = 1;
});
