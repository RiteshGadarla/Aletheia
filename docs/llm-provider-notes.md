# LLM provider notes — measured, not assumed

Provider `gemini`, model **`gemma-4-31b-it`** (display name "Gemma 4 31B IT").
Resolved from `GET /v1beta/models` on 2026-09-19. The other Gemma on the API is
`gemma-4-26b-a4b-it`. Both: 262144-token input limit, methods `generateContent`, `countTokens`.

## Measured behaviour

| Probe | Result | Consequence for the adapter |
|---|---|---|
| `systemInstruction` field | **HTTP 500 every time** | Gemma rejects system instructions. Fold the system prompt into the first user turn. |
| Plain `generateContent` | works, but returns **`"thought": true` parts** | It is a thinking model. Join only parts *without* the thought flag. |
| OpenAI-compat endpoint (`/v1beta/openai/chat/completions`) | works, but inlines `<thought>…</thought>` **into the content string** | Rejected. Stripping tags from prose is fragile → we use the **native** endpoint for `gemini`. |
| `responseMimeType: application/json` + `responseSchema` | **works**; response is a single clean part, no thought part | This is our primary structured-output mode. |
| Repeated identical calls | **~50% HTTP 500** (1/4 then 2/4 successful) | Not caused by `temperature`. Transient server-side. **Retry with exponential backoff is mandatory.** |
| Sustained load later the same session | **500, 503 and ReadTimeout**; 0/3 calls survived 4 retries each | The free-tier Gemma endpoint degrades badly under load. The heuristic fallback is not a nicety — it is the load-bearing path. |
| A reply that did arrive | rejected by our parser as "not JSON" | **Our bug, since fixed.** Gemma 4 is a *thinking* model and thought tokens count against `maxOutputTokens`; a 2048 budget truncated the JSON mid-object. Default raised to 8192 and a truncation-aware retry added. |

## Adapter rules that follow

1. Endpoint: `POST /v1beta/models/{model}:generateContent?key=…` (native, not OpenAI-compat).
2. No `systemInstruction`. Prepend the system prompt to the first user part.
3. Always send `generationConfig.responseMimeType="application/json"` + `responseSchema`.
4. Parse: `candidates[0].content.parts`, keep parts where `part.get("thought")` is falsy, join, `json.loads`.
5. Retry 5xx / timeouts up to 4 attempts, backoff 1s, 2s, 4s, 8s (+jitter). Then fall back to the
   heuristic proposal and surface "AI suggestion unavailable" — never block onboarding.
6. Budget at least **8192** output tokens. Thought tokens are billed against the same budget, so a
   budget sized for the answer alone truncates the JSON. On `finishReason: MAX_TOKENS`, retry once
   with double the budget before giving up.
6. Token usage from `usageMetadata.{promptTokenCount,candidatesTokenCount}` for the Settings counter.

## Sample output quality

Given the ASA 302013 template it returned a well-formed mapping with per-slot confidence, but
assigned `ip_a → src_endpoint.ip`, whereas for an **outbound** ASA 302013 the `for` side is the
remote party (spec §7.3 maps `ip_b → src_endpoint.ip` on outbound). A textbook case of why AI
output is a *proposal* that must clear the reconstruction gate, the replay diff and human review.

## Latency and the two bugs it exposed

Measured with a 180-second client timeout and a realistic OCSF-mapping prompt, successful calls
returned in **34 s and 50 s**. Two of our defaults were wrong for a thinking model, and both are fixed:

| Default | Was | Now | Why |
|---|---|---|---|
| `ALETHEIA_LLM_TIMEOUT_S` | 30 | **120** | Real calls take 34–50 s. A 30 s limit turned would-be successes into `ReadTimeout`, which is exactly what we first saw. |
| `ALETHEIA_LLM_MAX_OUTPUT_TOKENS` | 2048 | **8192** | Thought tokens are billed against the same budget, so 2048 truncated the JSON mid-object. A truncation-aware retry now doubles the budget on `finishReason: MAX_TOKENS`. |

Spec §8.12.9 suggests a 30 s default. That predates knowing the model reasons before answering, so we
deviate deliberately and document it here.

## Model reliability, measured side by side

Six identical JSON-mode calls per model, same key, same window:

| Model | Successful | Codes seen |
|---|---|---|
| `gemma-4-31b-it` | **3/6** | 200 x3, 503 x2, 500 x1 |
| `gemma-4-26b-a4b-it` | **6/6** | 200 x6 |

`gemma-4-26b-a4b-it` is the sparse/MoE variant (~4 B active parameters), so it is cheaper to serve
and visibly less contended. `gemma-4-31b-it` remains the configured default because it was the
model asked for; **if the assistant is flaky during a demo, switch to `gemma-4-26b-a4b-it` on the
Settings page** — no restart, no rebuild.

## Operational conclusion for the demo

Treat `gemma-4-31b-it` as **best-effort**. During one measurement window it answered roughly half
the time; in a later window it answered not at all, returning 500/503/timeout through every retry.
The product is designed for exactly this: heuristics always run first, the AI is a second opinion,
and any suggestion still has to clear the reconstruction gate, the replay diff and human approval.

Practical advice:
- Do not put a live "Ask AI" call on the critical path of a timed demo. Scenario 5c should be shown
  with a pre-captured suggestion, or with the fallback message, which is itself an honest
  demonstration of the design.
- For a more reliable cloud model, switch provider/model on the Settings page — no rebuild needed.
- For guaranteed offline behaviour, use `provider=ollama` with a local model.
