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
