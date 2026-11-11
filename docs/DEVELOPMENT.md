# Development

Contributor build, validation and release procedures for Pi Plannotator Compact. For installation and migration, see the [root README](../README.md).

The inherited UI/runtime retains plan revisions/diffs, markdown/HTML/live-app/folder/bundle annotations, drafts, diagram/question comments, review highlighting workers, AI/session bridges, guide sharing, themes/settings and external review engines. The extraction changes packaging, build scope and releases, not those features.

## Build from a clean checkout

Use Node **22+**, npm, **Bun 1.3.14** (the release/test version), bash, git, and network access. Bun 1.4.2 can build but changes Node HTTP listener behavior in the inherited network tests; use the pinned version for reproducible tests. Vite builds large inlined browser assets and need sufficient memory.

```bash
git clone https://github.com/FadhelHaidar/pi-plannotator-compact.git
cd pi-plannotator-compact
npm run install:dev
bun run build:pi
```

`install:dev` temporarily supplies only the retained Bun workspaces, installs from `bun.lock` with `--frozen-lockfile --no-save`, then restores the npm-safe root manifest. The root has no permanent `workspaces`: Pi's npm Git-source installation must not parse `workspace:*` dependencies. Do not run another installer concurrently. Avoid plain `bun install`, which can rewrite the workspace lock before the lifecycle bootstrap; use `npm run install:dev`.

`build:pi` builds `apps/review` first (including its inlined worker), then `apps/hook` (the plan/annotation browser shell), copies both HTML files to the extension, and runs `vendor.sh` to generate raw-TS backend modules, managed CallDiff inputs and the bundled skill. The names `hook`/`review` preserve upstream's internal layout; no non-Pi server or agent entrypoint is included. Generated outputs and dependencies are ignored, not committed. Dev-only UI previews are `bun run dev:hook` and `bun run dev:review`.

For a local installation **after building**:

```bash
pi install ./apps/pi-extension
# or, from outside the checkout, use its absolute path
```

Git-source installation is also available; it runs the full source bootstrap/build in postinstall and therefore needs Node, Bun, bash, network and lifecycle scripts:

```bash
pi install git:github.com/FadhelHaidar/pi-plannotator-compact
```

If interrupted, first ensure no bootstrap is still running, restore `package.json` from Git if it still contains the temporary workspace list, and remove `.pi-source-install.lock`. Rerun `npm run install:dev` and `bun run build:pi`. Do not delete a lock held by a live install.

### Tests and packaging

After the bootstrap/build:

```bash
bun run test:pi
bun run typecheck:pi
bun test packages/core packages/shared packages/ai
bun test packages/ui packages/editor packages/review-editor packages/guide-viewer
bun run test:ui                    # opt-in Happy DOM component tests
bun test scripts/install-pi-source.test.ts
node --test .github/scripts/bump-pi-version.test.mjs scripts/smoke-pi-package.test.mjs
bun run pack:pi                    # rebuild + pack + packed import/assets closure check
bun run smoke:discovery            # isolated Pi install/load/remove smoke, no model session
```

`pack:pi` produces `artifacts/plannotator-pi-extension.tgz`. `node scripts/pack-pi.mjs` packs already-built outputs without rebuilding. `smoke:package` requires the archive argument, for example `bun run smoke:package artifacts/plannotator-pi-extension.tgz`. The closure smoke parses the **unpacked tarball**, checks runtime imports/declarations, inlined HTML, the skill, managed CallDiff inputs and licenses. The discovery smoke uses Pi's real package installer/loader in a disposable HOME/agent directory, checks all five commands, both shortcuts, plan tools and flag, then removes the installation. It does not touch your settings or call a model/browser. It requires the host Pi dev dependency installed by the bootstrap.

Native dependencies may require allowed npm lifecycle scripts (notably WebTUI's `node-pty`); npm versions that block scripts need explicit approval under their own policy. SDK/CLI availability, credentials, git/jj/GitButler, platform browser/native tools and network-hosted services still govern optional capabilities. Automated tests skip JJ cases when `jj` is absent and DOM cases unless enabled. Timing-sensitive server suites can require `bun test --timeout 15000 apps/pi-extension` on busy machines. See [tests/UI-TESTING.md](../tests/UI-TESTING.md) for manual UI parity coverage. Passing package/discovery tests does not attest full interactive browser or external-provider parity.

### Pi compatibility refresh checks

The advertised minimum remains **0.79.1**. The Stage 1 refresh was checked against exact companion-package sets for **0.79.1, 1.2.0, 1.5.0 and 1.5.2**, separately from the workspace's Pi 1.0.0 development dependencies. Typechecks, real-loader/schema checks and 94 focused regression tests pass on each set; packed install/load/remove passes on the floor and latest. See [COMPATIBILITY-VALIDATION.md](COMPATIBILITY-VALIDATION.md) for baseline failures, browser evidence and untested platforms/providers. This does not establish every intermediate release or full interactive parity.

When repeating the matrix, use disposable npm hosts and copied workspaces with their four Pi peers (`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`) resolved to the exact target version. Check installed versions: installing coding-agent alone can resolve newer companion packages. Do not replace the real user's Pi, settings, credentials or keybindings. Run `tsc --noEmit -p apps/pi-extension/tsconfig.json` in each copy, validate tool arguments through that host's `pi-ai`, and run `scripts/smoke-pi-discovery.mjs` with its coding-agent dependency resolving to that host. The floor's npm shrinkwrap can place companion packages beneath coding-agent rather than at the host root.

Keep `before_agent_start` handling compatible with legacy events (no `messageType`) and modern user/custom events. Only this extension's Ask AI custom turn is exempt from phase preludes; unrelated custom turns still use existing phase behavior, and Ask AI must not consume pending phase-entry/off notices. Tool schemas are plain JSON Schema, avoiding the removed Pi 1.5 `pi-ai` `Type` export while retaining argument validation/coercion on old hosts. Checklist ordinal cleanup is presentation-only: never normalize the parser, execution IDs or approved plan text to fix display duplication.

## Releases and publication bootstrap

This is an independent **`vX.Y.Z`** release series. The old fork's last CT version was `0.1.0`; this standalone tree starts at **`0.1.1`**. Upstream version numbers are not used. Root/Pi manifest versions are set in the build workspace so both browser assets carry the release version.

`.github/workflows/test.yml` builds and validates pushes to branches and pull requests using Node 22 and Bun 1.3.14. `.github/workflows/pi-extension-release.yml` runs on pushes to `main` and repeats the release-critical checks before publishing. With **no release tags**, the first push bootstraps a release at the checked-in Pi version (`0.1.1`). After that it inspects non-merge commit messages since the highest stable release tag and uses the highest Conventional Commit bump:

| Commit | Bump |
| --- | --- |
| `feat:` / `feat(scope):` | minor |
| `fix:`, `perf:`, `revert:` | patch |
| conventional header with `!` or `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | major (including `0.x`) |
| `chore`, `docs`, `test`, `ci`, `build`, `style`, `refactor`, other maintenance | no release |

The release workflow builds from source, tests Pi/typecheck/extraction seams, packs the extension, checks the archive and isolated discovery, then publishes the same versioned package to npm as `@fadhelhaidar/pi-plannotator-compact` and uploads **`plannotator-pi-extension.tgz`** to a stable GitHub Release tagged `v<version>`. It does not commit version churn back to main. Keep release tags on main history; checked-in versions are the first-release baseline, not the authoritative latest released version.

To bootstrap the renamed npm package:

1. Build and check the package from a clean checkout, then publish once by hand (`npm publish --access public` from `apps/pi-extension`). npm cannot create a brand-new package through OIDC. The previous package name is a separate npm package; it is not renamed automatically.
2. Register the trusted publisher on npmjs.com for `@fadhelhaidar/pi-plannotator-compact`: GitHub Actions, repository `FadhelHaidar/pi-plannotator-compact`, workflow `pi-extension-release.yml`. Subsequent publishing uses GitHub OIDC without an npm token.
3. Keep the existing release tags. Renaming the repository does not reset the version series; maintenance-only commits do not trigger a release. Subsequent release-worthy main commits advance the version and publish under the new name.
4. Check the published npm package and test installation before retiring the old package. Existing GitHub Release tarballs still contain their original package name until replaced by a new release.

## Upstream porting

[EXTRACTION-FILES.txt](../EXTRACTION-FILES.txt) inventories the checked-in extraction files. This repository retains the Pi extension and its shared browser/runtime code, while removing other agent backends; Pi-only manifests, release/bootstrap adaptations, and compact-tracker behavior are intentional. Port upstream fixes into the corresponding source files under the preserved layout, not `apps/pi-extension/generated`. Run the source build, Pi/shared/UI tests, package closure and isolated discovery again; use the UI parity checklist before claiming browser equivalence. Non-Pi host integrations/workflows should not be reintroduced just to cherry-pick a shared fix.
