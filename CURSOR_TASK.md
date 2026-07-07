# Task: A4b — layer2_call metering emission at the MCP tool-call layer

Branch: `feat/a4b-layer2-metering`. Push the branch immediately after your FIRST commit and keep pushing after every commit. Delete this CURSOR_TASK.md before your final commit. Open a PR titled `feat(a4b): layer2_call metering events at the tool-call layer (Stripe test meter, env-gated)`.

## Context you cannot discover yourself

1. **Metering is an ICC contract ACCEPTANCE CRITERION**, not discretionary. The walkthrough story needs per-call metering visible.
2. **Stripe test-mode objects already exist** (created 2026-07-05, test mode only): billing meter `layer2_call` (id `mtr_test_61UzHInRw5N1hYEjh41FjAepSMTX7ItU`), products Hauska Layer 2 Builder ($49/mo + $0.04/call overage) and Pro Stream ($199/mo + $0.02/call). Stripe stays TEST MODE by operator ruling; no live keys exist.
3. The four-gate key model: keys carry `product` (public|codex|reporting|map) and `tier`. A "Layer 2 call" = a successful `tools/call` on a product-gated tool (product != public requirement) by a keyed caller. Public-product tools are Layer 1 (free, never metered).
4. This repo already logs `tool_call` events per request (see the logger events in src). The current subject/key context is available per-request via `getCurrentProduct()`/`getCurrentTier()` and the key row (post-#38 per-request threading — do NOT reintroduce module-level subject state; that exact bug was just fixed).

## Work

1. **Metering module** (`src/metering.ts`): `recordLayer2Call({ keyId, keyHash, product, tier, tool, requestId })` that:
   - ALWAYS emits a structured log event `layer2_call` (this is the native truth the command-center revenue panel will read),
   - AND, when `STRIPE_SECRET_KEY` env is set AND the key row has a `stripe_customer_id`, posts a Stripe billing meter event (`event_name: "layer2_call"`, `stripe_customer_id`, value 1, idempotency on requestId). Absent either → structured `layer2_call_unbilled` log with a reason field (`no_stripe_key` | `no_customer_mapping`). Never throw into the tool path; failures log `layer2_call_meter_error` and the tool response is unaffected.
2. **DB migration** (follow the numbered pattern in `migrations/`): add nullable `stripe_customer_id` to `api_keys`; extend the admin PATCH body (`src/admin.ts`) to set/clear it.
3. **Wire-up at the tool-call layer**: after a SUCCESSFUL product-gated tool call (gate passed, product != "public", handler did not return isError), call `recordLayer2Call`. One choke point, not per-tool edits — find the shared wrapper the tool handlers flow through (the same layer that emits `tool_call` logs).
4. **Tests**: metered vs public-tool (never metered) vs failed-call (never metered); no-stripe-key → unbilled log; customer-mapped + stripe key → Stripe client called with meter payload (mock fetch/client, no live Stripe calls); admin PATCH round-trip for stripe_customer_id.

## Constraints

- EXIT-BOUNDED commands only (npm run build / npm test). NEVER a dev server or watcher. No live Stripe calls anywhere (tests mock; you have no keys).
- Use the plain Stripe REST meter-events endpoint via fetch (no new heavyweight SDK dependency) unless `@hauska-sdk/metering`/`@hauska-sdk/payment` (now on npm) already provides a meter-event client — check them first (`npm view @hauska-sdk/metering`); consuming the SDK package is preferred if it fits (the pricing framework names the SDK as the payment substrate).
- Do not change gate behavior, tool schemas, or the request_log pipeline.
- Migration note for the reviewer: the planner applies migrations to prod Neon manually before deploy; name the migration file clearly.
