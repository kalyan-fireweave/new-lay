# Keel

<!-- fireweave:begin role=claude-entry format=2 sha256=044ba316c03ebeb94676dcd2648240ad599161c1634bc1389dd2560ff97e93d4 -->
## FireWeave

@.fireweave/agents-core.md

Claude Code: there is no ship command; safe-rollout has been removed. Run FireWeave's tools as `fw tool …` in the shell.

If FireWeave's rollout contract is not in your context (for example, Claude Code was started in a subdirectory), Read the repository-root `AGENTS.md` before changing code.
<!-- fireweave:end role=claude-entry -->

Keel is a client-only team board. Client docs and product code use Keel words: board, card, journey, run, application account, infrastructure account. The application account is the product. The infrastructure account is the machines. A finished export is a run id present in the application account and absent from the infrastructure account.

Keep these words out of client docs and product code: FireWeave, Oodle, signal-bench, bindings, capability ids.

## Stack

Node 22 or newer runs `.ts` files directly. Imports use `.ts` extensions. The package manager is pnpm 11.9.0. Leave the lockfile on that pnpm. Bundling is esbuild. OpenTelemetry package versions in `packages/otel` stay exact pins.

## Secrets

`.env` stays uncommitted. `.env.example` keeps vendor keys empty. Never print a password, a session token, or an `Authorization` value. Quote a vendor key in `.env` because the value contains a space: `KEEL_VENDOR_APP_API_KEY="Basic …"`.

## Contract

`implementation.html` is the contract. A phase is done when `node scripts/phases/phase-NN.mjs` exits 0 and the earlier phase scripts still exit 0. Edit `plan.html`, `explanation.html`, or `implementation.html` only to correct a statement the code has made false.

`pnpm check` is the local gate. After a web UI change, exercise the changed flow in the browser.

## Path rules

Read the matching file in `.claude/rules/` before editing that area. Cursor loads the same text from `.cursor/rules/`. Change both copies in the same edit.

- `apps/api/**`, `packages/contracts/**` → `api.md`
- `apps/web/**` → `web.md`
- `apps/studio/**`, `packages/journeys/**` → `studio.md`
- `collector/**`, `packages/otel/**`, `packages/catalog/**`, `scripts/render-collector.ts`, `scripts/prove.ts`, `scripts/doctor` → `telemetry.md`
- `scripts/**`, `infra/**`, `package.json`, `.github/**`, `.env.example` → `ops.md`
