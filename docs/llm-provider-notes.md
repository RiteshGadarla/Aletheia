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

## Adapter rules that follow

1. Endpoint: `POST /v1beta/models/{model}:generateContent?key=…` (native, not OpenAI-compat).
2. No `systemInstruction`. Prepend the system prompt to the first user part.
3. Always send `generationConfig.responseMimeType="application/json"` + `responseSchema`.
4. Parse: `candidates[0].content.parts`, keep parts where `part.get("thought")` is falsy, join, `json.loads`.
5. Retry 5xx / timeouts up to 4 attempts, backoff 1s, 2s, 4s, 8s (+jitter). Then fall back to the
   heuristic proposal and surface "AI suggestion unavailable" — never block onboarding.
6. Token usage from `usageMetadata.{promptTokenCount,candidatesTokenCount}` for the Settings counter.

## Sample output quality

Given the ASA 302013 template it returned a well-formed mapping with per-slot confidence, but
assigned `ip_a → src_endpoint.ip`, whereas for an **outbound** ASA 302013 the `for` side is the
remote party (spec §7.3 maps `ip_b → src_endpoint.ip` on outbound). A textbook case of why AI
output is a *proposal* that must clear the reconstruction gate, the replay diff and human review.
