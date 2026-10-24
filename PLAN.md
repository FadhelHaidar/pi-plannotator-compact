# Plan: Ask AI tables + upstream catch-up (Pi-only fork)

## Context

This repo is a Pi-only extraction of `backnotprop/plannotator`, forked at upstream
`545c7afc` (2026-10-09, upstream v0.28.9). Upstream is now v0.28.30 (2026-10-24):
**645 commits ahead**. The fork drops the non-Pi agent backends, Inbox, VS Code and
iPhone surfaces, so the commits that matter are the self-contained ones against code
this checkout still has.

**Problem 1 — Ask AI answers lose their tables.** `packages/ui/utils/aiChatFormat.ts`
renders answers with `marked`, then sanitizes with `DOMPurify`. The allowlist has no
`table`-family tags and no `align`, so DOMPurify drops the element and keeps cell text
on one line. Upstream fixed exactly this in `859164b9` (#2069); our file is still at
the pre-fix state.

Both chat surfaces share that util, so one fix covers both:
`packages/ui/components/ai/DocumentAIChatPanel.tsx:169` (plan review / annotate) and
`packages/review-editor/components/AITab.tsx:368` (code review).

**Problem 2 — 15 days of upstream fixes not ported.** Also pulled in this pass: a
**critical** DOMPurify advisory and four small self-contained UI fixes.

## Decisions (confirmed with the user)

- Scope: table fix + DOMPurify bump + the four tiny UI fixes. No medium/large features.
- Wide tables **scroll inside the panel** (upstream behaviour), not wrap or popout.
- Verification: targeted tests + typecheck. No full build / manual browser pass required.

## Approach

### Part A — Ask AI GFM tables (port of `859164b9`)

1. `packages/ui/utils/aiChatFormat.ts` — lift the allowlist out and add the table tags
   plus `align`:

   ```ts
   export const CHAT_SANITIZE_CONFIG = {
     ALLOWED_TAGS: [
       'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
       'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'blockquote',
       'table', 'thead', 'tbody', 'tr', 'th', 'td',
     ],
     // `align` is what marked writes on th/td for aligned GFM columns.
     ALLOWED_ATTR: ['href', 'rel', 'class', 'align'],
   };

   /** The markdown step of {@link renderChatMarkdown}, before sanitizing. */
   export function chatMarkdownToHtml(text: string): string {
     return marked.parse(text, { async: false, breaks: true }) as string;
   }
   ```

   `renderChatMarkdown` sanitizes `chatMarkdownToHtml(text)` with
   `[...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS]` / `[...ALLOWED_ATTR]` — DOM copying is needed
   because DOMPurify mutates the arrays it is handed. Leave `formatRelativeTime` alone.

2. `packages/ui/theme.css` — insert table rules right after the
   `.ai-markdown blockquote` block (ends ~line 1652, before the
   `/* Annotation highlights … */` comment):

   ```css
   /* GFM tables in Ask AI answers. The chat panel is narrow, so a wide table
      scrolls sideways inside itself instead of widening the message. */
   .ai-markdown table { display: block; max-width: 100%; overflow-x: auto;
     border-collapse: collapse; margin: 0.5rem 0; font-size: 0.95em; }
   .ai-markdown th, .ai-markdown td { border: 1px solid var(--border);
     padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
   .ai-markdown th { background: color-mix(in oklab, var(--muted) 55%, transparent);
     font-weight: 600; }
   .ai-markdown th[align="center"], .ai-markdown td[align="center"] { text-align: center; }
   .ai-markdown th[align="right"], .ai-markdown td[align="right"] { text-align: right; }
   ```

   `packages/review-editor/index.css:16` already imports `../ui/theme.css`, and its later
   `.ai-markdown` duplicate (line 2313+) redefines only p/heading/list rules, so it does
   not override `table`/`th`/`td`. No second copy of the CSS is needed.

3. New `packages/ui/utils/aiChatFormat.test.ts` (upstream test, no DOM): assert every
   tag/attribute `marked` emits for an aligned GFM table is in the allowlist, and that
   nothing script/embed/style-ish is allowed. `marked@17` emits `<th align="left">`
   (verified in this checkout), so the `align` entry is required.

**Not ported:** `packages/core/guide-viewer-manifest.ts` integrity bump from the same
upstream commit. That repo rebuilds a `viewer.<hash>.css` bundle embedding `theme.css`;
this fork has no guide-viewer asset build (no `viewer.*.css` anywhere, the manifest
points at a hosted `baseUrl`), so there is nothing here to re-hash.

### Part A2 — DOMPurify 3.4.17 (port of `b70536ae`)

`bun.lock:942` pins `dompurify@3.4.14`. GHSA-cg2g-xh64-v4q7 (SAFE_FOR_TEMPLATES bypass,
**critical**) covers `>=3.4.4, <=3.4.16`; 3.4.17 is the patched release. Bump the
`^3.4.14` range to `^3.4.17` in the root `package.json:35`, `packages/ui/package.json:88`
and `apps/review/package.json:14`, then refresh `bun.lock`.

### Part B — four small UI fixes

All four upstream patches are from a tree that has drifted from this fork, so re-apply
the changes by hand against the local files; do not `git apply`.

1. **Bare-URL autolinks** (`a1e4abc3` + `4029236a`) —
   `packages/ui/components/InlineMarkdown.tsx`. Add, after `trimUrlTail` (line 360), the
   helper that finds a bare `https?://` URL starting inside a plain-text chunk:

   ```ts
   const BARE_URL_SCHEME = /https?:\/\//g;
   const BARE_URL_AT = /https?:\/\/[^\s<>"']+/y;
   function bareUrlRunningPast(text: string, end: number): number { /* upstream body */ }
   ```

   and in the scan loop (`const nextSpecial = …`, line 1166) stop the chunk where that
   URL starts so the bare-URL branch above links it whole. Fixes `…/w/ws_01…` rendering
   as a link to `…/w/ws`. Cover with the upstream tests appended to
   `packages/ui/components/InlineMarkdown.test.ts`.

2. **Mermaid label wrap** (`f07a2af1`) — `packages/ui/utils/mermaid.ts`: export
   `MERMAID_LABEL_WRAP_WIDTH = 140` and set `flowchart.wrappingWidth` (line 61 block)
   plus a new `state: { wrappingWidth: MERMAID_LABEL_WRAP_WIDTH }`. Mermaid 12 lowered the
   default 200 → 120, which splits short labels. Extend `packages/ui/utils/mermaidTheme.test.ts`.

3. **`alert`/`confirm`/`prompt` in annotated pages** (`0676ff86`) —
   `packages/ui/components/html-viewer/HtmlViewer.tsx:1173` hardcodes
   `sandbox: "allow-scripts"`; export
   `HTML_VIEWER_SANDBOX = "allow-scripts allow-modals"` and use it, and change
   `packages/shared/html-assets.ts:21` `HTML_ASSET_DOCUMENT_CSP` to
   `"sandbox allow-scripts allow-modals"`. Both must match (a nested frame gets the
   intersection). Never add `allow-same-origin`. Update the assertions in
   `packages/ui/components/html-viewer/HtmlViewer.bridgeAsset.test.tsx`,
   `packages/ui/webmcp/iframeIsolation.test.ts` and
   `apps/pi-extension/server/serverAnnotate-embeds.test.ts`.

4. **Comment actions without hover** (`d97638a1`) —
   `packages/review-editor/components/CommentActions.tsx:26` is hover-only, and Tailwind's
   `group-hover:` only applies under `@media (hover: hover)`. Add an optional
   `selected?: boolean` prop that pins the row visible, pass it from
   `packages/review-editor/components/ReviewSidebar.tsx` (both call sites, ~474 and ~533
   with the existing `isSelected`), and add `group-focus-within:opacity-100
   [@media(hover:none)]:opacity-100` to the hover-reveal class strings in
   `CommentActions.tsx:26`, `CopyButton.tsx:61`, `FileCommentBanner.tsx`,
   `InlineAnnotation.tsx`, `PRCommentsTab.tsx:735`, `ReviewSidebar.tsx`,
   `ReviewAgentJobDetailPanel.tsx`, `ReviewPRArtifactsPanel.tsx`, `AgentsTab.tsx`,
   `AnnotationPanel.tsx:1103` & `:1257`, `AnnotationSidebar.tsx:64`,
   `AskSessionAnnouncementDialog.tsx`, `AttachmentsButton.tsx:260`,
   `CodeFilePopout.tsx:184`, `DiagramBlock.tsx:348`, `EditorAnnotationCard.tsx:45`,
   `ImageThumbnail.tsx:117`, `Settings.tsx:2319`, `TerminalToolsAnnouncementDialog.tsx`,
   `blocks/CodeBlock.tsx:57`. Add `tests/hover-reveal-actions.test.ts` (upstream, 83 lines).

## Files to modify

- `packages/ui/utils/aiChatFormat.ts`, `packages/ui/utils/aiChatFormat.test.ts` (new)
- `packages/ui/theme.css`
- `package.json`, `packages/ui/package.json`, `apps/review/package.json`, `bun.lock`
- `packages/ui/components/InlineMarkdown.tsx` + `InlineMarkdown.test.ts`
- `packages/ui/utils/mermaid.ts` + `mermaidTheme.test.ts`
- `packages/ui/components/html-viewer/HtmlViewer.tsx` (+ its tests),
  `packages/shared/html-assets.ts`, `packages/ui/webmcp/iframeIsolation.test.ts`,
  `apps/pi-extension/server/serverAnnotate-embeds.test.ts`
- `packages/review-editor/components/CommentActions.tsx`, `CopyButton.tsx`,
  `FileCommentBanner.tsx`, `InlineAnnotation.tsx`, `PRCommentsTab.tsx`,
  `ReviewSidebar.tsx`, `ReviewAgentJobDetailPanel.tsx`, `ReviewPRArtifactsPanel.tsx`
- `packages/ui/components/{AgentsTab,AnnotationPanel,AnnotationSidebar,AskSessionAnnouncementDialog,AttachmentsButton,CodeFilePopout,DiagramBlock,EditorAnnotationCard,ImageThumbnail,Settings,TerminalToolsAnnouncementDialog}.tsx`,
  `packages/ui/components/blocks/CodeBlock.tsx`
- `tests/hover-reveal-actions.test.ts` (new)

## Reuse

- `marked` + `DOMPurify` already wired in `renderChatMarkdown`; no new dependency.
- Existing theme tokens `--border`, `--muted` and the `color-mix(in oklab, …)` style
  already used by the neighbouring `.ai-markdown pre` block.
- `trimUrlTail` / `emitPlainTextWithBareUrls` in `InlineMarkdown.tsx` already do the
  trailing-punctuation and bare-URL work the autolink fix builds on.
- `trimUrlTail` and `sanitizeLinkUrl` also already exist — the fix is a chunk boundary,
  not a second parser.
- CI's own commands (`.github/workflows/test.yml`) for typecheck and non-DOM tests.

## Steps

- [x] 1. Add `packages/ui/utils/aiChatFormat.test.ts` first; confirm it fails against the
      current allowlist (red).
- [x] 2. Rewrite `aiChatFormat.ts` with `CHAT_SANITIZE_CONFIG` + `chatMarkdownToHtml`;
      re-run the test (green).
- [x] 3. Add the `.ai-markdown table/th/td` rules to `packages/ui/theme.css`.
- [x] 4. Bump DOMPurify to `^3.4.17` in the three manifests, run `bun install`, confirm a
      single `dompurify@3.4.17` entry in `bun.lock`.
- [x] 5. Port the bare-URL autolink fix + tests to `InlineMarkdown.tsx`.
- [x] 6. Port the Mermaid 140 px wrap + test.
- [x] 7. Port `allow-modals` (viewer sandbox + asset CSP) and update the three test files.
- [x] 8. Port `CommentActions.selected` + the hover/focus/touch visibility classes and add
      `tests/hover-reveal-actions.test.ts`.
- [x] 9. Update the README "upstream" note only if it names the fork point version
      (`README.md:140`); no other docs needed.

## Verification

- `bun test packages/ui/utils/aiChatFormat.test.ts` — new test; must fail before step 2.
- `bun test packages/ui/components/InlineMarkdown.test.ts packages/ui/utils/mermaidTheme.test.ts tests/hover-reveal-actions.test.ts`
- `DOM_TESTS=1 bun test packages/ui/components/html-viewer/HtmlViewer.bridgeAsset.test.tsx packages/ui/webmcp/iframeIsolation.test.ts`
- `bun test apps/pi-extension/server/serverAnnotate-embeds.test.ts`
- Typecheck, matching CI: `bun run typecheck:pi` and
  `bunx tsc --noEmit -p packages/ui/tsconfig.json` (plus
  `bunx tsc --noEmit -p packages/review-editor/tsconfig.json` since review components change).
- Regression sweep for the renderer: `bun test packages/ui packages/review-editor` (non-DOM).
- Dependency check: `grep -c 'dompurify@3.4.17' bun.lock` is 1 and no `3.4.14` remains.

## Risks

- `bun install` runs `postinstall: scripts/install-pi-source.mjs`, which rewrites workspace
  manifest wiring. Review the diff after the bump; do not commit unrelated manifest churn.
- DOMPurify mutates the allowlist arrays it is given — hand it copies, or the export is
  destroyed on first render.
- `display: block` on the table drops normal table box behaviour (no `caption` alignment,
  no `width: 100%`). Accepted: the chat panel is narrow and scrolling is the chosen
  behaviour.
- Part B patches come from a drifted upstream tree; each must be re-read against the local
  file. The hover fix is the riskiest (≈20 files of class strings) — keep it in its own
  commit so it can be dropped alone.

## Deferred backlog (triaged, not in this pass)

| Upstream | What it does | Note |
| --- | --- | --- |
| `49926537` | rendered Markdown previews in code review | medium feature |
| `88e5f869`, `d742651c` | Ask AI: start a new chat | medium feature |
| `9990ac99`, `b58d093d` | one Ask AI chat per session across annotate documents | medium feature |
| `0c0336bd`, `c66d2597` | document text size for plan review/annotate | medium feature |
| `06aa7c58` | plan review: one adaptive decision control | touches the review decision flow |
| `5757e98b` | comment on part of an image (region comments) | large |
| `1fb6cc09` | code review diagrams loaded on demand | large |
| `a3b443a9`, `1d38ef22` | Pi: restart notice after the package updated | needs a packaging plan |
| `826a8bc1`, `b3ff0b9e` | `PLANNOTATOR_BROWSER=none`, print session URL | partly present; packaging plan |
| `7e66f1cb`, `20330010`, `2f6ff5f1` | state-changing route guards, open-in guards, `/api/image` CSP | this fork already has `isSameOriginOrNoOrigin` guards; re-audit before porting |
| Inbox / VS Code / iPhone / opencode / codex / copilot | bulk of the 645 commits | surfaces removed from this extraction |
