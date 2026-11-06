<!-- fireweave:begin role=agents-core format=2 sha256=7b191efb74e1e9e7a34b014ad1b71a5a84ca809f4a826390d1b088ec7526b9dd -->
## FireWeave — rollout contract

FireWeave ships every behaviour change behind a control point and ramps it after merge. You prepare the change on a branch; merging the pull request into an environment branch registers it for that environment; a person starts the ramp.

**What you need.** Steps 1 and 3 need an authenticated `fw` that may write repo state (a signed-in profile, or an agent credential with write access); step 4 needs any authenticated `fw`. `fw status` shows which you have. When it reports no profile for this repo, ask the person to run `fw login`, then `fw select-project`: you cannot finish the sign-in yourself. Tools run as `fw tool <name> --input-file <json>`. If `fw` is missing here (a cloud agent, CI, a reviewer, an editor without FireWeave), do step 2 (and 4 if you can), then end your summary or PR description with the pending line below. Never write a manifest file, never call `fw api`, never invent `chg_`/`stmp_` ids.

**Classify first, in one line:** `change` (observable behaviour moves) · `inquiry` · `brainstorm` · `infra-only` (config, docs, formatting, tests: no behaviour delta). Only `change` runs the order below; when unclear, it is a `change`.

### HARD ORDER — every change

1. **Manifest first, on this branch.** `fw tool upsert-rollout-manifest` with `baseContentHash` (`null` = no row yet; on `conflict`, re-apply on `current` and retry). Take `chg_`/`stmp_` ids from `fw tool new-change-ids` (a stamp per surface); append each to its surface's `FW_STAMPS`.
2. **A new control point, anchored.** Gate the new behaviour behind a key FireWeave has never seen, read with default `false`, and put `// @fireweave-controlpoint <key>` at every evaluation site, in files this pull request changes. A merge registers only keys this change brings to the branch; reusing an existing key registers nothing new.
   - ts-server: `await fw.controlPoints.getBooleanValue('<key>', false, { targetingKey: user.id })` from `@fireweaveai/server-sdk/start`; local values in `src/fireweave/control-points.ts`
   - web: `fw.controlPoints.getBooleanValue('<key>', false)` from `@fireweaveai/web-sdk/start` (no per-call context); local values in `src/fireweave/control-points.ts`
3. **Signals at each control point.** Reuse an existing metric, add one in the same edit, or record `noSignalNeeded` with a reason. Amend the manifest (same tool, `baseContentHash` = the row you wrote).
4. **Check before the PR.** `fw tool assert-dev-checklist` must pass. `fw pr check` gives CI's verdict.
5. **Ship = a pull request.** Open it into the environment branch. The check **FireWeave — rollout readiness** must pass; it blocks an anchor whose manifest is missing on this branch. Merging registers the rollout for that branch's first environment, waiting to start. Later environments get theirs from a merge into their own branch, or by promotion on a shared one. A person starts each one. Never register, start, ramp or promote a rollout yourself. Never merge past a failing readiness check: never use `gh pr merge --admin`, and never create, edit, disable or delete a repository ruleset or branch protection.

**There is no ship command; safe-rollout has been removed.**

**Pending line** (when step 1 could not run): `FireWeave rollout package pending on <branch>: control point <key> is anchored; a developer with FireWeave write access must author its manifest on this branch (steps 1, 3, 4), then re-run the readiness check. Do not merge until it passes.`

**Reviewing a pull request:** point out behaviour changes with no control point, and anchors the readiness check reports as `unmanifested-anchor`. Do not ask for manifest files.

**Absence has names.** Only `never-authored` means author one. `not-fetched` → `fw sync`; `not-authorized` → withheld, not absent; `server-unavailable` → retry; `queued` → drain `.fireweave/.queue/`.

**Apps:** `apps/api` (ts-server) · `apps/web` (web). Each app's FireWeave files are listed under Rollout-ready layout in `.fireweave/agent-instructions.md`.

**When you need more,** read `.fireweave/agent-instructions.md`: Manifest contract · Deriving metrics · Cohort identity · How to emit a metric · FireWeave SDK configuration (per language).
<!-- fireweave:end role=agents-core -->
