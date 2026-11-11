# Pi refresh validation (2026-11-11)

Scope: Stage 1 of the approved fork-safe refresh only. No UI/dependency refresh, new notices, auto-reload, Inbox or non-Pi host support.

## Baseline before implementation

Environment: Linux, Node 24.20.0, Bun 1.3.14 via `npm exec --yes --package=bun@1.3.14 -- bun`. Workspace development Pi dependencies resolve to 1.0.0, so normal workspace tests alone are not a latest-Pi check.

The customization/preservation matrix is in the approved `plans/upstream-pi-refresh.md`. Its regression anchors cover tracker modes and mirror, keymap protection, phase prompts/tools, approved snapshots, model-switch failure, review closure/status persistence, comment toggle, Ask AI tables/images, touch actions, HTML/link safety and Pi-only packaging. Candidate changes are limited to the lifecycle handler, two tool schemas and duplicate-number presentation; original checklist text/ordinals must not change.

| Baseline check | Result |
| --- | --- |
| Pi tests, default 5-second timeout | 490 pass, 2 skip, 6 fail and 4 errors (annotation-draft HTTP timeouts) |
| Pi tests, `--timeout 20000` | 496 pass, 2 skip, 0 fail |
| Pi + UI typechecks (workspace host 1.0.0) | Pass |
| Core/shared/AI | 1825 pass, 16 skip |
| UI/editor/review/guide, DOM disabled | 1816 pass, 1422 skip |
| UI/editor/review/guide, `DOM_TESTS=1` | 3223 pass, 1 skip, 5 fail |
| Hover accessibility | 3 pass |
| Source installer | 9 pass |
| Node release/package-script tests | 11 pass |

DOM failures predated implementation: four `DocBadges` Finder-button assertions passed in isolation (the open-in catalog is memoized across tests); the compact-touch Ask AI textarea assertion in `packages/editor/App.archiveReadOnly.test.tsx` also failed in isolation. They were not silently treated as passing and were not changed as part of the compatibility port.

A separate test-only follow-up then fixed them. `packages/ui/components/DocBadges.test.tsx` reloads `DocBadges` and `OpenInAppButton` through Bun's module cache in `beforeEach`, so the placement checks render a fresh catalog cache against their own fetch stub while production keeps one fetch per session. `packages/editor/App.archiveReadOnly.test.tsx` now scopes the textarea lookup to the compact Ask AI stage and asserts the element exists before checking its mobile-editable attribute. No production UI behavior, dependency or reset hook changed.

Disposable exact-version npm hosts and copied workspaces were used rather than modifying the user's Pi installation. Each host pins all four Pi peer packages, not just coding-agent (npm can otherwise resolve newer companion versions).

| Pi version | Baseline TypeScript | Baseline actual Pi loader discovery |
| --- | --- | --- |
| 0.79.1 | Pass | Pass |
| 1.2.0 | Pass | Pass |
| 1.5.0 | Fails: pi-ai no longer exports `Type` | Pass through compatibility loader |
| 1.5.2 | Fails: pi-ai no longer exports `Type` | Pass through compatibility loader |

A browser baseline was opened using a disposable plan-server fixture and HOME, with no provider/model calls. Captured `/tmp/pi-refresh-validation/browser-before.png` and accessibility snapshot: default model picker is “Use execution settings”, alternative models appear, numbered checklist and table render. Live interactive TUI baselines are not automated; existing tracker/keymap/phase suites provide baseline evidence, not a claim of Windows/WSL parity. Raw logs and scratch hosts are under `/tmp/pi-refresh-validation` (temporary, not shipped).

## Baseline findings

- Latest Pi custom-triggered turns now run `before_agent_start`. Plannotator framing appended ahead of an Ask AI answer can be mistaken for another prompt by the session bridge. Preserve phase latches/off notice and unrelated custom-turn handling; scope any exemption to the affected Ask AI turn.
- `Type` imports from pi-ai no longer typecheck on Pi 1.5.x. Preserve the two tool schemas' JSON Schema semantics, argument validation and old-Pi support without introducing a new dependency.
- Numbered checkbox text is preserved by the parser, while tracker/status formatters add an ordinal again (`1. 1.`). Fix presentation only; never renumber execution IDs or rewrite the approved checklist.

## Implemented fixes

- Own Ask AI custom turns skip phase preludes before any latch is consumed. Other custom/user/legacy events retain the prior phase behavior. Three connected handler/bridge regressions cover planning, executing and pending idle-off notices; removing the guard makes all three fail.
- Both plan-tool schemas are equivalent plain JSON Schema objects. Required fields, descriptions, integer-step validation and numeric coercion are retained without importing a removed API or adding dependencies.
- A shared display helper removes one matching `step.` prefix followed by whitespace in widget/status text. Different leading numbers, parenthesized numbers and prefixes without whitespace are left alone. Completion persistence and approved snapshots retain the original text and IDs.

## Final automated results

| Check | Result |
| --- | --- |
| Pi (`bun test --timeout 20000 apps/pi-extension`) | 507 pass, 2 skip, 0 fail |
| Pi + UI workspace typechecks | Pass |
| Core/shared/AI | 1825 pass, 16 skip, 0 fail |
| UI/editor/review/guide, DOM disabled | 1816 pass, 1422 skip, 0 fail |
| `bun run test:ui` after test-only cleanup | 3228 pass, 1 skip, 0 fail |
| Targeted DOM preservation tests | 73 pass |
| Targeted approval/closure/persistence runtime tests | 66 pass |
| Hover / source installer / Node scripts | 3 / 9 / 11 pass |
| Build, pack, tarball closure and workspace discovery | Pass |

The 73 DOM checks include `AskAIImageAttach`, `aiChatFormat`, `PlanModelPicker`, `Viewer.drafts`, `CommentPopover.forcedDialog` and `agentClosed`; the 66 runtime checks include `plan-model-picker`, `decision-listener-throw`, `plannotator-events`, `phase-tools-runtime` and `nonblocking-plan-review`. The full DOM suite is now green after the test-only cleanup; this still is not a full-UI acceptance claim. One unrelated `CommentPopover.multiTarget` focus test exceeded the runner's 30-second budget once under full-suite load, then passed in isolation and on the next full run (8/8 in isolation), so it is recorded as timing-sensitive rather than silently excluded.

| Exact Pi peers | Typecheck | Real loader + tool-schema validation | Focused regressions | Packed install/load/remove |
| --- | --- | --- | --- | --- |
| 0.79.1 | Pass | Pass | 94 pass | Pass |
| 1.2.0 | Pass | Pass | 94 pass | Not run |
| 1.5.0 | Pass | Pass | 94 pass | Not run |
| 1.5.2 | Pass | Pass | 94 pass | Pass |

Each loader check found the five commands, both shortcuts, two plan tools and plan flag. Actual host argument validators accepted/coerced a numeric step and rejected missing, fractional and nonnumeric steps; the plan-path schema accepted a string and rejected a missing path. The 94 tests cover phase prompts, nonblocking review, session bridge, keymap, widget and tracker. They simulate host events; real loader/validator execution does **not** mean a live model turn was exercised.

Packaging produced `artifacts/plannotator-pi-extension.tgz`; closure checks found 176 runtime TS files, both inline HTML assets, skill, managed CallDiff inputs and licenses. All generated files came from the source build. Manifests, lockfile, dependency versions, release workflow and browser source are unchanged.

## Browser/TUI evidence and limits

- Real rebuilt plan-server page: default “Use execution settings”, alternate model selection, rendered table and global-comment second-click open/close passed in headless Chromium, using a disposable HOME and no model calls.
- Captured representative 1280×720 screenshots before and after: `/tmp/pi-refresh-validation/browser-before-ready.png`, `/tmp/pi-refresh-validation/browser-rebuilt-after-ready.png` and `/tmp/pi-refresh-validation/browser-matched-after.png`. Plan content/theme/layout remain visually consistent. These are **not pixel-identical**: existing cached generated HTML differs from the current source build in onboarding/Ask AI controls. No browser source was ported or edited for this refresh. Screenshot comparison does not establish complete UI parity.
- Tracker compact/full rendering, pending-window limit, overflow, width, duplicate-number removal, immutable snapshots, off-mode mirror/footer and keybinding protection are covered by automated tests. No live interactive terminal keystroke/screen-reader run or TUI screenshot was captured.
- Not exercised manually: Windows/WSL or macOS, actual Alt+P/Alt+T terminal interception, live provider/Ask AI requests or uploads, browser revise/approve submissions, HTML-viewer comment interaction, review-diff selection, native terminals/browser launch, JJ integration and external review engines. Existing targeted tests cover many of these code paths but are not a replacement for platform/provider checks.
- Fresh independent source review found no issues and returned “Merge verdict: OK.” It checked connected bridge event ordering, latch preservation, schemas and all display-helper callers; it did not independently rerun the test matrix or live model turns.
- Active LSP checks found no production TypeScript errors in changed files. Test files are excluded from the project tsconfig and report inferred-project `bun:test` resolution warnings. Existing broad lint warnings are not a clean-lint claim; the pre-existing `!wasOff === (mode !== "off")` visibility comparison was reviewed and marked a false positive.

Stage 2 was subsequently implemented as turndown 1.0.68, `@pierre/diffs` 1.6.4 and End-hold (`docs/STAGE2-UI-REFRESH.md`). Auto-reload is a separate follow-up on the same branch. The Pi version floor is unchanged; compatibility evidence above is bounded, not a guarantee of every release or complete browser/provider parity.

## Auto-reload follow-up

`apps/pi-extension/auto-reload.ts` ports the Pi half of upstream PR #2356. It checks on a 2 s poll and again inside the `plannotator-reload` command; a new version must be stable on disk for 10 s, the install must look finished, and the session must have no run, queued message, compaction, dialog, open review/plan/Ask, submitted prompt within 30 s, typing within 15 s, or editor text. One try per version; the marker survives `ctx.reload()`. Pi before 0.84.2 gets the `/reload` note instead of `sendUserMessage` with `expandPromptTemplates`. `autoReload` defaults on; `PLANNOTATOR_AUTO_RELOAD` wins over the config key.

| Check | Result |
| --- | --- |
| `auto-reload.test.ts` | 17 pass, 0 fail |
| `package-version.test.ts` | 5 pass, 0 fail |
| `packages/shared/config.test.ts` | 109 pass, 0 fail |
| Pi typecheck | Pass |
| `bun run build:pi` | Pass (review 16,588.44 kB / hook 21,995.88 kB) |
| `bun test --timeout 20000 apps/pi-extension` | 526 pass, 2 skip, 3 fail |
| Packed package | 228 files, 41.37 MB unpacked, 10.98 MB packed, shasum `52783dccbd2806a7932b5fda7f719a0be6699353`; smoke 178 runtime TS files |
| Isolated packed install/discovery/removal | Pass |

The three Pi-suite failures are the port-listener assertions in `apps/pi-extension/server/network.test.ts:178`, `:224` and `:243` under the current Bun 1.4.2. They reproduce on a clean HEAD with this work stashed, so they are recorded as pre-existing runner/environment behavior, not auto-reload regressions; the other 526 tests pass. Not exercised: a real `pi update --extensions` against a running session, an actual timed reload on Pi 0.84.2+, or the older-Pi note on a real 0.79.1 host. The tests fake the event bus and `reload()`; they do not prove live terminal/provider behavior.
