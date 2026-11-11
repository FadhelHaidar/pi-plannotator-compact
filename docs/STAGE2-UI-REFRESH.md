# Stage 2 UI refresh (2026-11-11)

Scope: the three separately approved Stage 2 items only — turndown bump, `@pierre/diffs` 1.6.4, and End-hold. The fork is Pi-only and remains based on upstream v0.28.5; no upstream branch or Inbox/Shape/Modern-theme code was merged.

## Commit set

| Commit | Change |
| --- | --- |
| `6afdc1c` | `@joplin/turndown-plugin-gfm` 1.0.68 in the root, shared and Pi manifests |
| `fefadb9` | `@pierre/diffs` 1.6.4, worker catalog stubs, partial-hydration patch, edit-session API migration |
| `25e51ee` | Standalone `useEndHold` on the old guide viewport manager, plus `docs/STAGE2-UI-REFRESH.md` |

## Turndown 1.0.68

The range and lockfile moved from `^1.0.64` (resolved 1.0.67) to `^1.0.68`. Existing GFM/table conversion and URL-to-markdown tests pass; no converter code changed.

## Pierre 1.6.4

- All five manifests now pin `@pierre/diffs` 1.6.4.
- `build/diffs-worker-catalogs.ts` supplies the worker-only Shiki language and Pierre theme catalogs; `build/pierre-highlights-stub.ts` keeps the main bundle from pulling the full catalogs. Vite aliases are registered in `apps/hook/vite.config.ts` and `apps/review/vite.config.ts`.
- `patches/@pierre%2Fdiffs@1.6.4.patch` restores the no-loader partial-diff hydration guard.
- `packages/review-editor/edit/pierreEditAdapter.ts` now constructs `Editor(editorType, options, editStateKey)`.
- `packages/review-editor/edit/useEditSession.ts` uses the 1.6 event callbacks `onItemEditChange(event, item)` / `onItemEditComplete(event, item, nextItem)`, returns `'reject'` after turning an edit into a suggestion, and uses `getViewState()`.
- `CodeViewAnnotationArgs` moved the owning item to the third tuple slot; `SelectedLineRange.side` is optional and defaults to the new side.
- Pi review bundle with stubs: 16,586.45 kB, gzip 4,496.91 kB. Without the stubs it measured 28,379.56 kB, gzip 6,472.87 kB.

Upstream v0.28.61 still uses the old edit callbacks, so this migration also fixes the latent edit-to-suggestion path in this fork; that feature remains gated by `enableEditSuggestions`.

## End-hold

Upstream #3052 is not applicable as a patch: this fork's `GuideViewportManager.tsx` is the 432-line v0.28.5 manager and has no `Landing`, `jumpTo`, `keyScroll`, or motion state. Porting it would mean bringing the intervening scroll-landing subsystem.

Instead, `packages/guide-viewer/useEndHold.ts` adds a bounded standalone hold:

- After an `End` key that actually moves the page and rests within one viewport of the end, keep `scrollTop` at `scrollHeight - clientHeight` while late file measurements change the end.
- Release on wheel, touch, pointer, mouse, any other key, or a scrollbar drag (detected as the view moving up while the scroll height is unchanged).
- Do not engage for `End` in an input, textarea, or contenteditable, or when `End` leaves the view more than one viewport from the end.
- Hold is capped at 2 s and also releases after 60 still frames.

The local file card has no resize-compensation effect, so the #3052 `GuideFileCard` shrink guard has no local counterpart to patch. This is a behavior reimplementation, not a port of the upstream landing tests.

## Validation

| Check | Result |
| --- | --- |
| `packages/shared` | 1402 pass, 16 skip, 0 fail |
| `packages/ui` | 1268 pass, 0 fail |
| `packages/review-editor` non-DOM | 363 pass, 277 skip, 0 fail |
| `packages/review-editor` DOM | 638 pass, 0 fail |
| `packages/guide-viewer` DOM | 37 pass, 0 fail |
| `npm run test:ui` | 3235 pass, 0 fail |
| Pi suite (`--timeout 20000`) | 507 pass, 2 skip, 0 fail |
| `bun run build:pi` | Pass (review and hook bundles built) |

The Pi suite's default 5-second budget produced 25 timeout failures under parallel full-suite load; the same files pass with the documented 20-second timeout. The suite was not treated as green at the default budget.

Not covered: a real long review on Windows/WSL, live providers, pixel-perfect visual parity, and manual interactive TUI shortcuts. The End-hold loop is covered by synthetic scroll tests, not a browser recording of the 300-file Inbox review that motivated #3052.

## Deferred/declined

- Click-a-word (#3046) and the drag fixes (#3042) need selection-pipeline work and a product decision.
- The Modern theme (#3058/#3028) is absent from this fork; adding it is new UI, not a refresh.
- Shape gating (#2974) does not apply: this fork has no Shape subsystem and Pi mounts no Shape routes.
- Auto-reload, OMP, Inbox, mascot, TLS warnings, and new changelog behavior remain out of scope.
