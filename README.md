# Pi Plannotator Compact

A standalone [Pi coding agent](https://github.com/earendil-works/pi) extension for browser plan review, annotations, code/PR review, and a compact execution tracker. This fork retains the inherited Plannotator UI/runtime and publishes separately as **`@fadhelhaidar/pi-plannotator-compact`**.

## Install, update, remove

Requires **Pi 0.79.1+** and its supported Node runtime. Prebuilt installs need no Bun or source build:

```bash
pi install npm:@fadhelhaidar/pi-plannotator-compact
# Or use the prebuilt GitHub Release tarball:
pi install 'npm:@fadhelhaidar/pi-plannotator-compact@https://github.com/FadhelHaidar/pi-plannotator-compact/releases/latest/download/plannotator-pi-extension.tgz'

pi update --extensions
# Or update only this source:
pi update npm:@fadhelhaidar/pi-plannotator-compact

pi remove npm:@fadhelhaidar/pi-plannotator-compact
```

For tarball installs, pass the **exact configured source string** above to `pi update` or `pi remove`. Restart Pi or run `/reload` after updating. Pi does not poll for releases; plain `pi update` updates Pi itself, not extensions.

### Migrating from an older fork or upstream

**Do not load two copies with the same commands.** Stop Pi, remove the old source, install this package, then restart. Use `pi list` to check configured sources:

```bash
pi remove npm:@fadhelhaidar/plannotator-pi-ct
# Old compact-plan-tracker release URL:
pi remove 'npm:@plannotator/pi-extension@https://github.com/FadhelHaidar/plannotator/releases/latest/download/plannotator-pi-extension.tgz'
# Upstream npm package:
pi remove npm:@plannotator/pi-extension
```

Remove only the source you installed (use its exact string for local/git installs), plus any manually configured old extension paths, global or project-local. Keep `~/.plannotator` data/config and Pi keybindings; no migration or deletion is needed. This repository does not edit Pi settings/keybindings automatically. The old npm packages are separate distributions, not renamed in place.

## Tracker, plan mode and shortcuts

- `/plannotator-tracker [off|compact|full|toggle|status]`: **compact** (default) shows `Plan: X/Y complete`, up to three pending steps and a hidden-step count (five rows maximum, no completed rows). **Full** shows all steps with completed steps struck through. **Off** hides the widget but keeps the footer and enforces mirroring to a detected todo provider, even when `todoProvider` is `"off"`. Legacy `on` means compact. **Alt+T** cycles off → compact → full.
- `piProgressWidgetMode` persists in `~/.plannotator/config.json`; the old boolean visibility key is still readable.
- `/plannotator-plan-mode` or **Alt+P** toggles plan mode; `pi --plan` starts in plan mode. Other commands: `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`.
- On WSL/Windows, Pi may reserve `alt+p` for model-cycle-backward. Merge `"app.model.cycleBackward": "alt+m"` into `~/.pi/agent/keybindings.json` to free it. Extension shortcuts are raw keys, not remapped by that file.

See the [complete extension usage/configuration reference](apps/pi-extension/README.md). The bundled `/skill:plannotator` is discovered only if no other copy is loaded; its CLI examples refer to the external Plannotator CLI, **not shipped here**.

## Source, tests and releases

Source builds require Node **22+**, npm, **Bun 1.3.14**, bash, git and network access:

```bash
npm run install:dev
bun run build:pi
bun run test:pi
bun run typecheck:pi
# Install locally only after building:
pi install ./apps/pi-extension
```

Use `install:dev`, not plain `bun install`; it temporarily bootstraps the retained workspaces while keeping the root manifest npm-safe. Git-source installation (`pi install git:github.com/FadhelHaidar/pi-plannotator-compact`) runs the full bootstrap/build and needs lifecycle scripts enabled.

`bun run pack:pi` builds and validates `artifacts/plannotator-pi-extension.tgz`; `bun run smoke:discovery` checks isolated Pi install/load/remove. Releases use an independent **`vX.Y.Z`** series (old CT: `0.1.0`; standalone baseline: `0.1.1`). Release-worthy Conventional Commits on `main` drive version bumps; the workflow publishes to npm and GitHub Releases without committing version churn.

See [Development](docs/DEVELOPMENT.md) for clean-checkout setup, all test commands, build/install recovery, packaging checks, release rules, npm trusted-publisher bootstrap and upstream porting. Package tests do not establish full interactive browser or external-provider parity.

## Origin and licenses

Original: [backnotprop/plannotator](https://github.com/backnotprop/plannotator), by backnotprop and contributors. Extraction source: [FadhelHaidar/plannotator](https://github.com/FadhelHaidar/plannotator), branch **`compact-plan-tracker`**, commit **`cd97439a0b578c070f098813ff1c973c914cbfbd`**. Compact tracker and Alt+P changes originate there. [EXTRACTION-FILES.txt](EXTRACTION-FILES.txt) inventories the extraction; this tree retains Pi/shared browser/runtime code, not other agent backends.

Inherited project/Pi code uses **MIT OR Apache-2.0**; `packages/ui` and `packages/core` explicitly use **Apache-2.0**. See [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE), [NOTICE](NOTICE) and preserved package/asset notices. Inherited code is not relicensed; dependency licenses remain their own. This is not a legal audit.
