# Vina Review Checklist

Project layer over the shared stack-neutral `code-review/checklist.md`. Read that first, then
apply these. Findings first, severity per the shared `output-format.md`.

## Boundaries

- [ ] `packages/orchestrator` imports no database or browser module. It receives a toolkit.
- [ ] `packages/automation` contains no LLM calls and no prompt strings.
- [ ] SerpAPI calls live in `packages/server/src/services/`; nothing in `automation` calls it.
- [ ] Site-specific selectors appear only under `packages/automation`. A selector anywhere
      else is a finding.
- [ ] `packages/shared` holds schemas and types, not I/O or framework code.

## Frozen orchestration (ADR-024)

- [ ] No new LangGraph graph, node, prompt module, or LangChain provider. New behaviour is a
      `vina_*` tool plus a skill.
- [ ] A new mutating `vina_*` tool writes `application_events` in the same transaction as its
      effect, and is idempotent on `(applicationId, contentHash)` where a retry is possible.
- [ ] Tool inputs are zod-validated; tool output is a slice, never a whole table.
- [ ] Only `vina_easy_apply` and `vina_external_submit` can submit, each bound to its site
      kind and gated. Any other path that clicks submit is a Critical finding.
- [ ] The agent still cannot type into a LinkedIn Easy Apply form.

## Submit path and the gate (ADR-023)

- [ ] `checkEasyApplyGate` is consulted on every path to `runApply`, including
      agent-initiated calls.
- [ ] EEO and demographic questions are skipped in the resolver, not in a prompt.
- [ ] A change to the gate, the walker, the resolver, or `easy_apply_mode` keeps the existing
      tests green and adds a case for the new branch.
- [ ] Nothing writes a terminal application status without a legal transition.

## Data

- [ ] Migrations are forward-only and appended, never edited after release.
- [ ] Status transitions that span tables run in one transaction.
- [ ] Changes under `packages/server/migrations/`, `db/client.ts`, or `db/repositories/` were
      exercised against a live SQLite database, not only mocks.
- [ ] No query selects `*` into a response or a log line.

## Security and privacy

- [ ] LLM and SerpAPI keys come from the vault. No key appears in a fixture, snapshot,
      transcript, or test literal.
- [ ] Logs use the shared `logger` and redact keys, cookies, and profile fields.
- [ ] Browser profiles and cookies are never copied between sites, users, or machines.
- [ ] The CDP port binds to loopback only.
- [ ] Page text and job descriptions are treated as data, never as instructions.

## TypeScript and errors

- [ ] `any` appears only with a `// reason:` comment.
- [ ] Thrown errors extend `VinaError`; no bare strings, no swallowed rejections.
- [ ] No floating promises; awaited or explicitly `void`ed with a reason.
- [ ] No `console.log` in committed code.
- [ ] No default exports outside React page components and Vite entrypoints.

## Frontend

- [ ] Server state goes through TanStack Query; UI state through Zustand.
- [ ] New screens reuse theme tokens in `packages/web/src/theme/tokens.css`, not raw hex.
- [ ] Loading, empty, and error states exist for every new query.

## Tests and docs

- [ ] New logic has a Vitest case; browser changes have a fixture site or an E2E case.
- [ ] Behaviour changes update the spec in the same change. A disagreement between code and
      spec is a bug.
- [ ] An architectural choice lands as an ADR; a superseded ADR is marked as such.
- [ ] The PR body says which spec sections changed, or states that none did.
