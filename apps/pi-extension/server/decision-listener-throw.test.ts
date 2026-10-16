/**
 * Ported from upstream (#1864, part of the crash fix in upstream 31f99196;
 * the session-closed/409 half is covered below).
 *
 * A decision reaches code another extension instance owns (the event API's
 * review-result emit). After /reload or a session switch that code throws
 * Pi's stale-ctx error SYNCHRONOUSLY. The decision is published from inside
 * the HTTP handler, so a throw that escapes there is an uncaught error that
 * ends the whole Pi process.
 *
 * What regresses if this fails:
 *  - a throwing decision listener crashes Pi (or fails the reviewer's POST).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import * as integrations from "./integrations.ts";
import { startPlanReviewServer } from "./serverPlan.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;

async function sandboxed(run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-decision-listener-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
		delete process.env.PLANNOTATOR_PORT;
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/** Collect anything the host would see as a fatal process error while `run` executes. */
async function trapFatal(run: () => Promise<void>): Promise<unknown[]> {
	const fatal: unknown[] = [];
	const onFatal = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	try {
		await run();
		// Let any escaped microtask or timer surface before the hooks come off.
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	}
	return fatal;
}

const postJson = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("a decision consumer that throws synchronously never escapes the HTTP handler", () => {
	test("plan: POST /api/approve answers normally and every other listener still runs", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Throwing listener ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			const seen: string[] = [];
			try {
				const fatal = await trapFatal(async () => {
					server.onDecision(() => {
						seen.push("stale");
						throw new Error(STALE_MESSAGE);
					});
					server.onDecision((result) => {
						seen.push(result.approved ? "approved" : "denied");
					});
					const res = await postJson(`${server.url}/api/approve`, {});
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({ ok: true });
					expect(await server.waitForDecision()).toMatchObject({ approved: true });
				});
				expect(fatal).toEqual([]);
				expect(seen.sort()).toEqual(["approved", "stale"]);
			} finally {
				server.stop();
			}
		}));

	test("plan: a throwing listener on deny is just as harmless", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Throwing listener deny ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			try {
				const fatal = await trapFatal(async () => {
					server.onDecision(() => {
						throw new Error(STALE_MESSAGE);
					});
					const res = await postJson(`${server.url}/api/deny`, { feedback: "no" });
					expect(res.status).toBe(200);
				});
				expect(fatal).toEqual([]);
			} finally {
				server.stop();
			}
		}));
});


describe("plan session closure keeps drafts without a reviewer decision", () => {
	test("broadcasts once, refuses both decisions and revisions, and never calls a decision listener", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Session closed ${Math.random()}`, htmlContent: MINIMAL_HTML });
			const seen: unknown[] = [];
			const stream = await fetch(`${server.url}/api/external-annotations/stream`);
			const reader = stream.body!.getReader();
			try {
				await reader.read(); // opening snapshot
				await postJson(`${server.url}/api/draft`, { annotations: [{ id: "kept" }], codeAnnotations: [], globalAttachments: [] });
				server.onDecision((result) => { seen.push(result); });
				expect(server.closeKeepingDraft()).toEqual({ closed: true, unsentAnnotations: 1 });
				expect(new TextDecoder().decode((await reader.read()).value)).toContain(
					'data: {"type":"session-closed","by":"session","unsentAnnotations":1}',
				);
				expect(server.closeKeepingDraft()).toEqual({ closed: false, reason: "decided" });
				expect(server.hostControl.status().decided).toBe(true);
				expect(server.hostControl.close).toBeUndefined();
				expect(server.updatePlan("# Too late")).toBeNull();
				server.onDecision((result) => { seen.push(result); });
				void server.waitForDecision().then((result) => { seen.push(result); });
				for (const route of ["approve", "deny"]) {
					const res = await postJson(`${server.url}/api/${route}`, {});
					expect(res.status).toBe(409);
					expect(await res.json()).toMatchObject({ closedByHost: true });
				}
				// A last debounce-window save remains possible until the server stops.
				await postJson(`${server.url}/api/draft`, { annotations: [{ id: "kept" }, { id: "late" }], codeAnnotations: [], globalAttachments: [] });
				expect((await (await fetch(`${server.url}/api/draft`)).json()).annotations).toHaveLength(2);
				expect(seen).toEqual([]);
				server.stop();
				expect(await reader.read()).toEqual({ value: undefined, done: true }); // no duplicate closure
			} finally {
				await reader.cancel();
				server.stop();
			}
		}));

	test("a tab subscribing after closure receives the terminal event during shutdown grace", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Late subscriber ${Math.random()}`, htmlContent: MINIMAL_HTML });
			try {
				server.closeKeepingDraft();
				server.stop();
				const stream = await fetch(`${server.url}/api/external-annotations/stream`);
				const events = await stream.text();
				expect(events).toContain('"type":"snapshot"');
				expect(events).toContain('"type":"session-closed","by":"session"');
				expect(events.match(/"type":"session-closed"/g)).toHaveLength(1);
			} finally {
				server.stop();
			}
		}));

	test("close followed by stop delivers SSE and accepts the final draft save before bounded shutdown", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Drain ${Math.random()}`, htmlContent: MINIMAL_HTML });
			const stream = await fetch(`${server.url}/api/external-annotations/stream`);
			const reader = stream.body!.getReader();
			try {
				await reader.read();
				server.closeKeepingDraft();
				server.stop();
				let tail = "";
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					tail += new TextDecoder().decode(chunk.value);
				}
				expect(tail).toContain('"type":"session-closed","by":"session"');
				const finalSave = await postJson(`${server.url}/api/draft`, { annotations: [{ id: "last-debounce" }], codeAnnotations: [], globalAttachments: [] });
				expect(finalSave.status).toBe(200);
				expect((await (await fetch(`${server.url}/api/draft`)).json()).annotations).toEqual([{ id: "last-debounce" }]);
				const lateDecision = await postJson(`${server.url}/api/approve`, {});
				expect(lateDecision.status).toBe(409);
				expect((await lateDecision.json()).closedByHost).toBe(true);
				server.stop(); // Repeated stop cannot shorten the draft-save grace.
				await new Promise((resolve) => setTimeout(resolve, 175));
				await expect(fetch(`${server.url}/api/plan`)).rejects.toThrow();
			} finally {
				await reader.cancel();
				server.stop();
			}
		}));

	test.each(["approve", "deny"])("closure wins while /api/%s is still reading a partial body", (route) =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Partial ${Math.random()}`, htmlContent: MINIMAL_HTML });
			let decisions = 0;
			server.onDecision(() => { decisions += 1; });
			const body = JSON.stringify({ feedback: "too late", planSave: { enabled: false } });
			let req!: ReturnType<typeof request>;
			try {
				const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
					req = request(`${server.url}/api/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
						let text = "";
						res.on("data", (chunk) => { text += chunk; });
						res.on("end", () => resolve({ status: res.statusCode, body: text }));
					});
					req.on("error", reject);
					req.write(body.slice(0, 1));
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(server.closeKeepingDraft().closed).toBe(true);
				req.end(body.slice(1));
				const res = await response;
				expect(res.status).toBe(409);
				expect(JSON.parse(res.body).closedByHost).toBe(true);
				expect(decisions).toBe(0);
			} finally {
				req?.destroy();
				server.stop();
			}
		}));

	test("an already claimed decision wins; closed and revised status cannot override it", () =>
		sandboxed(async () => {
			let release!: (value: { success: boolean }) => void;
			let claimed!: () => void;
			const started = new Promise<void>((resolve) => { claimed = resolve; });
			const integration = spyOn(integrations, "saveToObsidian").mockImplementation(() => {
				claimed();
				return new Promise((resolve) => { release = resolve; });
			});
			const server = await startPlanReviewServer({ plan: `# Claimed ${Math.random()}`, htmlContent: MINIMAL_HTML });
			try {
				const response = postJson(`${server.url}/api/approve`, { planSave: { enabled: false }, obsidian: { vaultPath: "/unused", plan: "test" } });
				await started;
				expect(server.closeKeepingDraft()).toEqual({ closed: false, reason: "decided" });
				expect(server.updatePlan("# Revision")).toBeNull();
				release({ success: true });
				expect((await response).status).toBe(200);
				expect(await server.waitForDecision()).toMatchObject({ approved: true });
				expect(server.closeKeepingDraft()).toEqual({ closed: false, reason: "decided" });
			} finally {
				integration.mockRestore();
				server.stop();
			}
		}));
});
