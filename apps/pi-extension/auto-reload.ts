/**
 * Pi reloads itself to load an updated Plannotator.
 *
 * An update replaces this package's files under a running Pi, which keeps the
 * old code until the person types `/reload`. Here Pi reloads by itself,
 * through its own command path: `pi.sendUserMessage("/plannotator-reload
 * auto", { expandPromptTemplates: true })` runs this extension's command,
 * whose context has `reload()`. Pi 0.84.2 added `expandPromptTemplates`;
 * before it the same call would send the text to the model, so an older Pi
 * gets only the one-line note.
 *
 * It reloads only when nothing can be lost:
 *   - the same new version has been on disk for STABLE_MS, counted from when
 *     the install looks finished (npm's retired copy of the package is gone,
 *     the entry and every dependency are on disk);
 *   - no run: agent_start .. agent_settled, ctx.isIdle(), no queued message;
 *   - no submitted prompt on its way to a run: Pi runs its `input` handlers
 *     before the run starts;
 *   - no compaction and no /tree branch summary;
 *   - no dialog of any extension open (ui_prompt_start .. ui_prompt_end);
 *   - no Plannotator review, plan review or Ask question open;
 *   - nothing typed for QUIET_MS, and an empty editor.
 * All of it is checked on every poll and again inside the command, the last
 * moment before the reload. One try per version per process.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadedPackageVersion, packageInstallSettled, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";

export const AUTO_RELOAD_COMMAND = "plannotator-reload";
/** The same version on disk this long before it is loaded. */
export const STABLE_MS = 10_000;
/** An install that still looks unfinished this long after its version appeared is not loaded. */
export const INSTALL_STUCK_MS = 5 * 60_000;
/** Nothing typed this long before a reload. */
export const QUIET_MS = 15_000;
/** A submitted prompt that never started a run stops holding the reload after this long. */
export const INPUT_GRACE_MS = 30_000;
/** How often the version on disk and the session are looked at. */
export const POLL_MS = 2_000;
/** A /tree branch summary holds the reload from session_before_tree until session_tree. */
export const TREE_HOLD_MAX_MS = 5 * 60_000;
/** A marker older than this is not the reload that is loading now. */
const MARKER_MAX_AGE_MS = 60_000;
/** Pi added `expandPromptTemplates` to `sendUserMessage` in 0.84.2. */
export const MIN_PI_FOR_AUTO_RELOAD = "0.84.2";

const MARKER_KEY = "__plannotatorAutoReload_v1";
const NOTICED_KEY = "__plannotatorUpdateNoticed_v1";
const TRIED_KEY = "__plannotatorAutoReloadTried_v1";

interface ReloadMarker {
	from: string | null;
	to: string;
	at: number;
}

function store(): Record<string, unknown> {
	// SAFETY: this is the only cross-extension-reload store; every key is namespaced below,
	// and the values are written and read only by this module.
	return globalThis as unknown as Record<string, unknown>;
}

function processSet(key: string): Set<string> {
	const s = store();
	const existing = s[key];
	if (existing instanceof Set) return existing as Set<string>;
	const fresh = new Set<string>();
	s[key] = fresh;
	return fresh;
}

function noticed(): Set<string> {
	return processSet(NOTICED_KEY);
}

function readMarker(): ReloadMarker | undefined {
	const marker = store()[MARKER_KEY] as ReloadMarker | undefined;
	return marker && typeof marker.to === "string" ? marker : undefined;
}

function clearMarker(): void {
	delete store()[MARKER_KEY];
}

/** The line after an automatic reload. */
export function autoReloadedText(to: string): string {
	return `Plannotator updated to ${to}. Pi reloaded while idle.`;
}

/** "0.84.2" >= "0.84.2"; anything unparseable counts as too old. */
export function piSupportsAutoReload(version: string | null | undefined): boolean {
	if (typeof version !== "string" || !version) return false;
	const parse = (v: string) => v.trim().replace(/^v/, "").split(/[-+]/)[0]!.split(".");
	const have = parse(version);
	if (have.length < 3 || have.slice(0, 3).some((n) => !/^\d+$/.test(n))) return false;
	const need = [0, 84, 2] as const;
	for (let i = 0; i < 3; i++) {
		const h = Number(have[i]);
		const n = need[i as 0 | 1 | 2];
		if (h > n) return true;
		if (h < n) return false;
	}
	return true;
}

/** Everything the decision reads, at one moment. */
export interface QuietState {
	now: number;
	running: boolean;
	idle: boolean;
	pendingMessages: boolean;
	compacting: boolean;
	openPrompts: number;
	inputAt: number | null;
	lastKeyAt: number | null;
	editorText: string;
	plannotatorBusy: string | null;
}

/** Why a reload must wait now, or null when nothing can be lost. */
export function reloadBlockedBy(s: QuietState): string | null {
	if (s.running || !s.idle) return "a run";
	if (s.pendingMessages) return "a queued message";
	if (s.compacting) return "a compaction";
	if (s.inputAt !== null && s.now - s.inputAt < INPUT_GRACE_MS) return "a submitted prompt";
	if (s.openPrompts > 0) return "an open dialog";
	if (s.plannotatorBusy) return s.plannotatorBusy;
	if (s.lastKeyAt !== null && s.now - s.lastKeyAt < QUIET_MS) return "typing";
	if (s.editorText.trim() !== "") return "text in the editor";
	return null;
}

/** The slice of Pi's ExtensionAPI this module uses (a fake in the tests). */
export type AutoReloadPi = Pick<ExtensionAPI, "sendUserMessage" | "registerCommand"> & {
	on(event: string, handler: (event: any, ctx: any) => void): void;
	/** The commands as Pi invokes them (a name two extensions register is renamed `name:1`, `name:2`). */
	getCommands?: () => ReadonlyArray<{ name: string; source?: string }>;
};

/** `/plannotator-reload` text, which reaches the `input` handlers only when Pi found no command by that name. */
const COMMAND_TEXT = new RegExp(`^/${AUTO_RELOAD_COMMAND}(?:\\s|$)`);

export interface AutoReloadOptions {
	/** resolveAutoReload(config, env), read once per extension instance. */
	enabled: boolean;
	/** Plannotator's own open work: a review, a plan review, an Ask question; null when none. */
	plannotatorBusy: () => string | null;
	/** Pi's version, or null when unknown (then: the note only). */
	piVersion: () => Promise<string | null>;
	/** Overridable for tests. */
	readOnDisk?: () => string | null;
	/** Whether the install on disk looks finished. */
	installSettled?: () => boolean;
	loaded?: string | null;
	now?: () => number;
	/** Tests drive `check()` themselves. */
	poll?: boolean;
}

export interface AutoReloadController {
	/** One poll now (the timer runs it every POLL_MS). */
	check(): void;
	/** Settles once the Pi version gate is decided. */
	ready: Promise<void>;
}

export function setupAutoReload(pi: AutoReloadPi, options: AutoReloadOptions): AutoReloadController {
	const now = options.now ?? Date.now;
	const readOnDisk = options.readOnDisk ?? (() => readPackageVersion());
	const installSettled = options.installSettled ?? (() => packageInstallSettled());
	const loaded = options.loaded !== undefined ? options.loaded : loadedPackageVersion();
	const mayAuto = options.enabled;
	let auto = false;
	let decided = !mayAuto;
	let ctx: ExtensionContext | null = null;
	let running = false;
	let sawSettled = false;
	let compacting = false;
	let treeAt: number | null = null;
	let openPrompts = 0;
	let inputAt: number | null = null;
	let lastKeyAt: number | null = null;
	let candidate: { version: string; seen: number; since: number; settled: boolean } | null = null;
	const attempted = processSet(TRIED_KEY);
	let afterReload: { message: string; kind: "info" | "warning" } | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopKeys: (() => void) | null = null;

	const ready: Promise<void> = mayAuto
		? options
				.piVersion()
				.then(
					(v) => {
						auto = piSupportsAutoReload(v);
					},
					() => {
						auto = false;
					},
				)
				.finally(() => {
					decided = true;
				})
		: Promise.resolve();

	const hasUI = (c: ExtensionContext | null): boolean => {
		try {
			return !!c?.hasUI;
		} catch {
			return false;
		}
	};

	const state = (c: ExtensionContext): QuietState => {
		let idle = false;
		let pendingMessages = true;
		let editorText = "";
		try {
			idle = c.isIdle();
			pendingMessages = c.hasPendingMessages();
			const text = (c.ui as { getEditorText?: () => string }).getEditorText?.();
			editorText = typeof text === "string" ? text : "";
		} catch {
			// A replaced or closed session: never quiet.
			idle = false;
		}
		return {
			now: now(),
			running,
			idle,
			pendingMessages,
			compacting: compacting || (treeAt !== null && now() - treeAt < TREE_HOLD_MAX_MS),
			openPrompts,
			inputAt,
			lastKeyAt,
			editorText,
			plannotatorBusy: options.plannotatorBusy(),
		};
	};

	const notify = (target: ExtensionContext | null, message: string, kind: "info" | "warning") => {
		try {
			target?.ui.notify(message, kind);
		} catch {
			// The session is gone.
		}
	};

	const sessionFree = (c: ExtensionContext): boolean => {
		if (running) return false;
		try {
			return c.isIdle();
		} catch {
			return false;
		}
	};

	/**
	 * Pi runs `/plannotator-reload` as a command: false when Pi says it has
	 * none by that name (two loaded copies rename it `:1`, `:2`). Unknown (an
	 * older Pi, a throw): true, and the `input` handler keeps the text from
	 * the model if Pi does not run it.
	 */
	const commandReachable = (): boolean => {
		try {
			const commands = pi.getCommands?.();
			if (!Array.isArray(commands)) return true;
			return commands.some((cmd) => cmd?.name === AUTO_RELOAD_COMMAND && (cmd.source === undefined || cmd.source === "extension"));
		} catch {
			return true;
		}
	};

	const tick = () => {
		const c = ctx;
		if (!c || !hasUI(c)) return;
		if (afterReload) {
			notify(c, afterReload.message, afterReload.kind);
			afterReload = null;
		}
		if (!decided) return;
		const onDisk = readOnDisk();
		if (!onDisk || !loaded || onDisk === loaded) {
			candidate = null;
			return;
		}
		if (candidate?.version !== onDisk) {
			candidate = { version: onDisk, seen: now(), since: now(), settled: installSettled() };
			return;
		}
		// The stable time counts from when the install looks finished: npm writes package.json first.
		const settled = installSettled();
		if (!settled) {
			candidate.since = now();
			candidate.settled = false;
		} else if (!candidate.settled) {
			// npm writes package.json before the rest; count stability from the first
			// moment the install looks whole, not from when the new version appeared.
			candidate.since = now();
			candidate.settled = true;
		}
		const stuck = !settled && now() - candidate.seen >= INSTALL_STUCK_MS;
		if (!stuck && now() - candidate.since < STABLE_MS) return;
		if (!auto || attempted.has(onDisk) || stuck) {
			// Off, an older Pi, the one try is spent, or an install that never finished: the note, once per version.
			if (sessionFree(c) && !noticed().has(onDisk)) {
				noticed().add(onDisk);
				notify(c, packageUpdatedMessage(loaded, onDisk), "warning");
			}
			return;
		}
		if (reloadBlockedBy(state(c)) !== null) return;
		attempted.add(onDisk);
		noticed().add(onDisk);
		if (!commandReachable()) {
			notify(c, packageUpdatedMessage(loaded, onDisk), "warning");
			return;
		}
		store()[MARKER_KEY] = { from: loaded, to: onDisk, at: now() } satisfies ReloadMarker;
		try {
			pi.sendUserMessage(`/${AUTO_RELOAD_COMMAND} auto`, { expandPromptTemplates: true });
		} catch {
			clearMarker();
			notify(c, packageUpdatedMessage(loaded, onDisk), "warning");
		}
	};

	pi.registerCommand(AUTO_RELOAD_COMMAND, {
		description: "Reload Pi to load the updated Plannotator (the same as /reload)",
		handler: async (args, cmdCtx) => {
			const automatic = args.trim() === "auto";
			if (automatic) {
				// Checked again here, in the command: the last moment before the reload.
				const marker = readMarker();
				if (!marker || reloadBlockedBy(state(cmdCtx)) !== null) {
					clearMarker();
					// Not a spent try: the next quiet moment tries again.
					if (marker) attempted.delete(marker.to);
					return;
				}
			}
			await cmdCtx.reload();
			// A new instance takes the marker in its session_start, before reload() returns.
			// Still here with the marker: no Plannotator loaded. Either Pi refused the reload
			// (its warning says why; this context still works, so the note follows it), or Pi
			// reloaded and the update failed to load (Pi's "Failed to load extension" line;
			// this context is stale and notify() drops the note).
			const left = readMarker();
			if (automatic && left) {
				clearMarker();
				notify(cmdCtx, packageUpdatedMessage(left.from, left.to), "warning");
			}
		},
	});

	pi.on("session_start", (event, c: ExtensionContext) => {
		ctx = c;
		running = false;
		sawSettled = false;
		openPrompts = 0;
		inputAt = null;
		lastKeyAt = null;
		compacting = false;
		treeAt = null;
		const marker = readMarker();
		if (marker && now() - marker.at >= MARKER_MAX_AGE_MS) clearMarker();
		else if (marker && (event as { reason?: string } | undefined)?.reason === "reload") {
			clearMarker();
			// The new version loaded: say so. Another one loaded (Pi read the package from
			// elsewhere, or the files changed again): the note, since this was the one try.
			if (marker.to === loaded) afterReload = { message: autoReloadedText(marker.to), kind: "info" };
			else afterReload = { message: packageUpdatedMessage(loaded, marker.to), kind: "warning" };
		}
		if (!hasUI(c)) return;
		stopKeys?.();
		stopKeys = null;
		try {
			stopKeys = c.ui.onTerminalInput(() => {
				lastKeyAt = now();
				return undefined;
			});
		} catch {
			stopKeys = null;
		}
		if (!timer && options.poll !== false) {
			void ready.then(() => {
				if (timer || !ctx) return;
				timer = setInterval(tick, POLL_MS);
				(timer as { unref?: () => void }).unref?.();
			});
		}
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = null;
		stopKeys?.();
		stopKeys = null;
		ctx = null;
	});
	pi.on("input", (event, c: ExtensionContext) => {
		const text = typeof event?.text === "string" ? event.text.trim() : "";
		if (COMMAND_TEXT.test(text)) {
			// Pi found no command by this name (it renamed it, two copies are loaded): this text must
			// never reach the model. The automatic one gets the note instead of the reload.
			const marker = readMarker();
			if (marker && text.slice(AUTO_RELOAD_COMMAND.length + 1).trim() === "auto") {
				clearMarker();
				notify(c ?? ctx, packageUpdatedMessage(marker.from, marker.to), "warning");
			}
			return { action: "handled" };
		}
		inputAt = now();
		return undefined;
	});
	pi.on("agent_start", () => {
		running = true;
		inputAt = null;
	});
	// Pi 0.80.4+ ends a run with agent_settled (after its follow-ups); before it, agent_end.
	pi.on("agent_end", () => {
		if (!sawSettled) running = false;
	});
	pi.on("agent_settled", () => {
		sawSettled = true;
		running = false;
	});
	pi.on("session_before_compact", () => {
		compacting = true;
		return undefined;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	// A /tree branch summary: Pi counts it as a compaction and refuses a reload during it.
	pi.on("session_before_tree", (event) => {
		const started = now();
		treeAt = started;
		const signal = (event as { signal?: AbortSignal } | undefined)?.signal;
		try {
			signal?.addEventListener(
				"abort",
				() => {
					if (treeAt === started) treeAt = null;
				},
				{ once: true },
			);
		} catch {
			// No signal: session_tree or the time limit ends it.
		}
		return undefined;
	});
	pi.on("session_tree", () => {
		treeAt = null;
	});
	pi.on("ui_prompt_start", () => {
		openPrompts++;
	});
	pi.on("ui_prompt_end", () => {
		openPrompts = Math.max(0, openPrompts - 1);
	});

	return { check: tick, ready };
}
