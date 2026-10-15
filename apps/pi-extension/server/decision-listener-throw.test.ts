/**
 * Ported from upstream (#1864, part of the crash fix in upstream 31f99196;
 * the session-closed/409 half is a separate fork follow-up, not tested here).
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
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
