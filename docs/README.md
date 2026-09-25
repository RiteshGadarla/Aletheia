# Aletheia documentation

[Project README](../README.md) · [Setup guide](../SETUP.md)

Everything about Aletheia beyond the README: how it is built, the interfaces between its parts, and
the measurements behind its claims.

## Documents

| Document | Read it to | Length |
| :--- | :--- | :--- |
| [Setup guide](../SETUP.md) | Install and start Aletheia with Docker, or from source on Linux, macOS or Windows | short |
| [Architecture](architecture.md) | Understand the components, the data flow, the integrity model and deployment, in two pages | short |
| [Technical specification](technical-specification.md) | Read the complete design: problem analysis, algorithms, formats, trade-offs, limitations | long |
| [Shared contracts](CONTRACTS.md) | Look up an interface: bus topics, message and pack formats, database schemas, HTTP APIs, environment variables | reference |
| [Alerting](alerting.md) | Configure alert rules, contact points and notification policies, and use the Grafana dashboards | medium |
| [Benchmarks](benchmarks.md) | See measured throughput, storage and integrity results, and reproduce them | medium |
| [LLM provider notes](llm-provider-notes.md) | Learn how Gemini and local model servers behave, and what the adapters do about it | short |

## Suggested reading order

**Evaluating Aletheia:** the [README](../README.md) (quick start and guided evaluation), then
[Architecture](architecture.md), then [Benchmarks](benchmarks.md).

**Operating it:** the [Setup guide](../SETUP.md), the configuration section of the
[README](../README.md#configuration), then [Alerting](alerting.md).

**Changing the code:** [Architecture](architecture.md), then the [Shared contracts](CONTRACTS.md)
for the component you are working on, then the relevant sections of the
[Technical specification](technical-specification.md).

## Conventions

- **Measured, not estimated.** Every number in these documents comes from the harness in
  [`bench/`](../bench/) or from a Demo Console scenario, together with the machine it ran on.
- **Requirements (a)–(k)** refer to the lettered requirements of SIH Problem Statement 26156; the
  mapping is in the [README](../README.md#requirement-traceability).
- **Section numbers** such as "spec §11.6" refer to the [Technical specification](technical-specification.md).
