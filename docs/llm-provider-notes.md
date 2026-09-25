# Aletheia — LLM provider notes

[← Documentation index](README.md) · [Project README](../README.md)

## Providers and model

| Provider | What it is | Model |
|---|---|---|
| `gemini` (default) | Google's Gemini API, the only cloud option | **`gemini-3.5-flash-lite`** by default, any `gemini-*` accepted |
| `local` | any local OpenAI-compatible server (Ollama, vLLM, llama.cpp, LM Studio). `ollama` is accepted as a legacy alias | whatever the server hosts; `llm.base_url` picks the server (default `http://localhost:11434/v1`) |
| `none` | AI off; rules map every format | — |

On `gemini`, only `gemini-*` models are supported: saving another model is rejected (HTTP 422), a
stale non-Gemini value from env or the settings table falls back to the default, and model lists
only show `gemini-*`. Gemma is no longer used. For air-gapped deployments use `provider=local`
instead; air-gap mode refuses the cloud provider.

## Settings

The settings table (written from the Settings page) wins over env, and env only supplies defaults.

| Setting | Env default | Default |
|---|---|---|
| `llm.provider` | `ALETHEIA_LLM_PROVIDER` | `gemini` |
| `llm.model` | `ALETHEIA_LLM_MODEL` | `gemini-3.5-flash-lite` |
| `llm.chat_model` | `ALETHEIA_LLM_CHAT_MODEL` | empty (Lyra uses `llm.model`) |
| `llm.base_url` | `ALETHEIA_LLM_BASE_URL` | per provider; required for `local` |
| `llm.send_samples` | `ALETHEIA_LLM_SEND_SAMPLES` | `masked` (`masked` / `none` / `raw`; `raw` is refused for Gemini) |
| `llm.timeout_s` | `ALETHEIA_LLM_TIMEOUT_S` | 120 |
| `llm.max_output_tokens` | `ALETHEIA_LLM_MAX_OUTPUT_TOKENS` | 8192 |
| `llm.requests_per_hour` | `ALETHEIA_LLM_REQUESTS_PER_HOUR` | 60 |

**API key.** The key has no env setting: enter it on the Settings page, where it is sealed with
`ALETHEIA_SECRET` before it is stored and only its last four characters are ever shown. `make seed`
reads `ALETHEIA_LLM_API_KEY` from `deploy/secrets/aletheia.env` and stores it the same way. Studio
does not read `ALETHEIA_LLM_API_KEY` or `ALETHEIA_LLM_API_KEY_FILE` itself when it runs. The
shipped image has no key, so `gemini` stays unavailable until one is set.

## Where the LLM is used

1. **Onboarding mapping (the core use).** Each new source is clustered into its unique formats and a
   byte-exact template is derived per format, deterministically. The LLM then maps each template's
   slots to OCSF from a few masked samples: **one request per unique format, never per event.**
   Rules fill any slot the LLM leaves unmapped, and stand in for the LLM when it is off, rate-limited,
   failing, or its mapping fails the reconstruction gate. The review screen shows which one mapped
   each format (`AI · gemini/…` or `Rules`) and why rules were used. A human still approves.
   A reviewer can instead **retry** with written feedback (and an optional class hint); the
   feedback goes into the next mapping request.
2. **Lyra** (the data assistant), several calls per question.

Runtime parsing never uses the LLM: the Go engine applies the approved templates.

## Lyra and `llm.chat_model`

Lyra has no separate fast model. It uses `llm.model`, by default the same `gemini-3.5-flash-lite`,
which is fast enough for its loop of at most 5 steps per question. `llm.chat_model` points Lyra alone
at another model (Gemini models only; a non-Gemini value is ignored) and caps its output budget at
4096 tokens. It is set through `ALETHEIA_LLM_CHAT_MODEL` or the settings table, not on the Settings
page. If `llm.chat_model` is empty (the default), Lyra uses the main model.

## Adapter rules

1. Official `google-genai` SDK, native `generateContent` (not the OpenAI-compatible endpoint).
2. `system_instruction` carries the system prompt.
3. Structured output: `response_mime_type="application/json"` + `response_schema`. Replies are
   still parsed tolerantly — a code fence or trailing prose is stripped before `json.loads`.
4. `gemini-3*` take `thinking_level="minimal"`; `gemini-2*` take `thinking_budget=0`.
5. Budget **8192** output tokens; on `finish_reason=MAX_TOKENS` retry once with double the budget.
6. Retries: up to 4 attempts. 5xx and timeouts back off 1/2/4/8 s (+jitter). **429 waits for the server's
   `retryDelay`, or 20/40/60 s** — free-tier limits are per-minute token windows, which a short
   backoff cannot outlast. Onboarding runs at most 2 mapping requests at a time for the same reason.
7. After the last attempt the call fails cleanly and rules take over; onboarding is never blocked.
8. Token usage from `usage_metadata` feeds the Settings usage counter. `llm.requests_per_hour`
   caps onboarding and Lyra calls together; once it is reached, onboarding falls back to rules
   and Lyra declines until the hour window frees up.
9. `local` goes through the OpenAI-compatible adapter with the same retry rules and JSON schema.

## Sample output quality

AI output is a *proposal*. On the ASA 302013 template a model assigned `ip_a → src_endpoint.ip`,
whereas for an **outbound** 302013 the `for` side is the remote party (spec §7.3). That is why every
mapping must clear the reconstruction gate and human review before it is used.
