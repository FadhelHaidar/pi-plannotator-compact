import { beforeEach, describe, expect, test } from "bun:test";
import {
	AUTO_RELOAD_COMMAND,
	INPUT_GRACE_MS,
	QUIET_MS,
	STABLE_MS,
	piSupportsAutoReload,
	reloadBlockedBy,
	setupAutoReload,
	type AutoReloadPi,
	type QuietState,
} from "./auto-reload.ts";

const KEYS = ["__plannotatorAutoReload_v1", "__plannotatorUpdateNoticed_v1", "__plannotatorAutoReloadTried_v1"] as const;

function resetProcessState(): void {
	for (const key of KEYS) delete (globalThis as Record<string, unknown>)[key];
}

function quiet(overrides: Partial<QuietState> = {}): QuietState {
	return {
		now: 1_000,
		running: false,
		idle: true,
		pendingMessages: false,
		compacting: false,
		openPrompts: 0,
		inputAt: null,
		lastKeyAt: null,
		editorText: "",
		plannotatorBusy: null,
		...overrides,
	};
}

type Handler = (event: any, ctx: any) => void;

class FakePi implements AutoReloadPi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	readonly sent: Array<{ content: string; options?: unknown }> = [];
	readonly commandsAtPi: Array<{ name: string; source?: string }> = [{ name: AUTO_RELOAD_COMMAND, source: "extension" }];

	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string, options?: unknown): void {
		this.sent.push({ content, options });
	}

	getCommands(): ReadonlyArray<{ name: string; source?: string }> {
		return this.commandsAtPi;
	}

	async emit(event: string, payload: any, ctx: any): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
	}
}

function makeCtx(options: { idle?: boolean; pending?: boolean; editor?: string; hasUI?: boolean } = {}) {
	const notifications: Array<{ message: string; kind?: string }> = [];
	let keyHandler: (() => void) | undefined;
	let reloads = 0;
	const ctx = {
		hasUI: options.hasUI ?? true,
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pending ?? false,
		ui: {
			notify: (message: string, kind?: string) => notifications.push({ message, kind }),
			getEditorText: () => options.editor ?? "",
			onTerminalInput: (handler: () => void) => {
				keyHandler = handler;
				return () => {
					keyHandler = undefined;
				};
			},
		},
		reload: async () => {
			reloads++;
		},
	};
	return {
		ctx,
		notifications,
		type: (text: string) => keyHandler?.(text),
		markReload: () => {
			reloads++;
		},
		get reloads() {
			return reloads;
		},
	};
}

function harness(overrides: { enabled?: boolean; version?: string | null; disk?: string | null; loaded?: string; settled?: boolean; reset?: boolean } = {}) {
	if (overrides.reset !== false) resetProcessState();
	let clock = 0;
	let disk = overrides.disk ?? "0.1.0";
	const pi = new FakePi();
	const controller = setupAutoReload(pi, {
		enabled: overrides.enabled ?? true,
		plannotatorBusy: () => null,
		piVersion: async () => overrides.version ?? "1.0.0",
		readOnDisk: () => disk,
		installSettled: () => overrides.settled ?? true,
		loaded: overrides.loaded ?? "0.1.0",
		now: () => clock,
		poll: false,
	});
	return {
		pi,
		controller,
		setDisk: (value: string | null) => {
			disk = value;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		get clock() {
			return clock;
		},
	};
}

beforeEach(resetProcessState);

describe("piSupportsAutoReload", () => {
	test("accepts 0.84.2 and newer, rejects older and unparseable versions", () => {
		expect(piSupportsAutoReload("0.84.2")).toBe(true);
		expect(piSupportsAutoReload("v0.84.3")).toBe(true);
		expect(piSupportsAutoReload("1.0.0")).toBe(true);
		expect(piSupportsAutoReload("0.84.1")).toBe(false);
		expect(piSupportsAutoReload("0.84")).toBe(false);
		expect(piSupportsAutoReload("")).toBe(false);
		expect(piSupportsAutoReload(null)).toBe(false);
		expect(piSupportsAutoReload("dev")).toBe(false);
	});
});

describe("reloadBlockedBy", () => {
	test("allows only a genuinely quiet session", () => {
		expect(reloadBlockedBy(quiet())).toBeNull();
		expect(reloadBlockedBy(quiet({ running: true }))).toBe("a run");
		expect(reloadBlockedBy(quiet({ idle: false }))).toBe("a run");
		expect(reloadBlockedBy(quiet({ pendingMessages: true }))).toBe("a queued message");
		expect(reloadBlockedBy(quiet({ compacting: true }))).toBe("a compaction");
		expect(reloadBlockedBy(quiet({ inputAt: 1_000 - INPUT_GRACE_MS + 1 }))).toBe("a submitted prompt");
		expect(reloadBlockedBy(quiet({ openPrompts: 1 }))).toBe("an open dialog");
		expect(reloadBlockedBy(quiet({ plannotatorBusy: "an open plan review" }))).toBe("an open plan review");
		expect(reloadBlockedBy(quiet({ lastKeyAt: 1_000 - QUIET_MS + 1 }))).toBe("typing");
		expect(reloadBlockedBy(quiet({ editorText: "draft" }))).toBe("text in the editor");
	});

	test("the grace windows end", () => {
		expect(reloadBlockedBy(quiet({ inputAt: 1_000 - INPUT_GRACE_MS }))).toBeNull();
		expect(reloadBlockedBy(quiet({ lastKeyAt: 1_000 - QUIET_MS }))).toBeNull();
	});
});

describe("setupAutoReload", () => {
	test("reloads once after a stable update and records the marker", async () => {
		const h = harness();
		const { ctx, notifications } = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		await h.controller.ready;

		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS - 1);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(0);

		h.advance(1);
		h.controller.check();
		expect(h.pi.sent).toEqual([{ content: `/${AUTO_RELOAD_COMMAND} auto`, options: { expandPromptTemplates: true } }]);

		// One try per version: a second poll does not send again.
		h.advance(STABLE_MS);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(1);
		expect(notifications).toHaveLength(0);
	});

	test("waits while Plannotator has work open", async () => {
		resetProcessState();
		const pi = new FakePi();
		let clock = 0;
		let busy = "an open review";
		const controller = setupAutoReload(pi, {
			enabled: true,
			plannotatorBusy: () => busy,
			piVersion: async () => "1.0.0",
			readOnDisk: () => "0.2.0",
			installSettled: () => true,
			loaded: "0.1.0",
			now: () => clock,
			poll: false,
		});
		const { ctx } = makeCtx();
		await pi.emit("session_start", { reason: "startup" }, ctx);
		await controller.ready;
		controller.check();
		clock += STABLE_MS;
		controller.check();
		expect(pi.sent).toHaveLength(0);

		busy = null;
		controller.check();
		expect(pi.sent).toHaveLength(1);
	});

	test("does not reload while a submitted prompt, typing, or a dialog holds it", async () => {
		const h = harness();
		const { ctx } = makeCtx({ editor: "half-written" });
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		await h.controller.ready;
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(0);

		// Clear the editor and type: the quiet window holds it.
		(ctx.ui as { getEditorText: () => string }).getEditorText = () => "";
		await h.pi.emit("input", { text: "hello" }, ctx);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(0);
		h.advance(INPUT_GRACE_MS);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(1);
	});

	test("an older Pi gets the note, never a message that could reach the model", async () => {
		const h = harness({ version: "0.84.1" });
		const { ctx, notifications } = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		await h.controller.ready;
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(0);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.kind).toBe("warning");
		expect(notifications[0]?.message).toContain("/reload");
	});

	test("disabled means the note, once per version", async () => {
		const h = harness({ enabled: false });
		const { ctx, notifications } = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		h.controller.check();
		expect(h.pi.sent).toHaveLength(0);
		expect(notifications).toHaveLength(1);
	});

	test("the command re-checks quiet and reloads; the new instance reports success", async () => {
		const h = harness();
		const first = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, first.ctx);
		await h.controller.ready;
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		const command = h.pi.commands.get(AUTO_RELOAD_COMMAND);
		expect(command).toBeDefined();

		// A real reload evaluates the module again and starts the replacement instance
		// before ctx.reload() returns; the new controller sees 0.2.0 loaded.
		const h2 = harness({ loaded: "0.2.0", disk: "0.2.0", reset: false });
		const second = makeCtx();
		const firstRun = makeCtx();
		firstRun.ctx.reload = async () => {
			firstRun.markReload();
			await h2.pi.emit("session_start", { reason: "reload" }, second.ctx);
		};
		await command!.handler("auto", firstRun.ctx);
		expect(firstRun.reloads).toBe(1);
		await h2.controller.ready;
		h2.controller.check();
		expect(second.notifications).toContainEqual({ message: "Plannotator updated to 0.2.0. Pi reloaded while idle.", kind: "info" });
	});

	test("the command does not reload when work appeared after the send", async () => {
		const h = harness();
		const first = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, first.ctx);
		await h.controller.ready;
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		const command = h.pi.commands.get(AUTO_RELOAD_COMMAND)!;
		const busy = makeCtx({ idle: false });
		await command.handler("auto", busy.ctx);
		expect(busy.reloads).toBe(0);
	});

	test("intercepts /plannotator-reload text that Pi found no command for", async () => {
		const h = harness();
		const { ctx, notifications } = makeCtx();
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		await h.controller.ready;
		h.setDisk("0.2.0");
		h.controller.check();
		h.advance(STABLE_MS);
		h.controller.check();
		expect(h.pi.sent).toHaveLength(1);
		const result = await (h.pi.handlers.get("input")?.[0] as Handler | undefined)?.({
			text: `/${AUTO_RELOAD_COMMAND} auto`,
		}, ctx);
		expect(result).toEqual({ action: "handled" });
		expect(notifications).toHaveLength(1);
	});
});
