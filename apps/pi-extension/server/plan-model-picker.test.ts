/**
 * The approval model picker's server half: the host's catalog reaches the tab
 * at /api/models, and an approve carrying `modelSwitch` puts the pick on the
 * decision the extension applies before executing.
 *
 * What regresses if this fails: the picker renders an empty list, or the pick
 * is dropped (silently approving with the model the reviewer did not choose).
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlanReviewServer, type PlanModelOption } from "./serverPlan.ts";
import { detectProjectName } from "./project.ts";
import { generateSlug, getPlanVersionPath } from "../generated/storage.ts";

import * as browserRuntime from "../plannotator-browser-runtime.ts";
import * as network from "./network.ts";
import { startPlanReviewBrowserSession, openPlanReviewBrowser } from "../plannotator-browser.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

const CATALOG: PlanModelOption[] = [
	{ provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" },
	{ provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];
const CURRENT: PlanModelOption = { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" };

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-plan-model-"));
	tempDirs.push(dir);
	process.env.PLANNOTATOR_DATA_DIR = dir;
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	const project = detectProjectName();
	for (const plan of createdPlans) {
		const versionPath = getPlanVersionPath(project, generateSlug(plan), 1);
		if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
	}
});

function newPlan(): string {
	const plan = `# Pi plan model test ${Math.random().toString(36).slice(2, 10)}\n\nStep one.\n`;
	createdPlans.push(plan);
	return plan;
}

async function withServer<T>(
	options: Parameters<typeof startPlanReviewServer>[0],
	body: (server: Awaited<ReturnType<typeof startPlanReviewServer>>) => Promise<T>,
): Promise<T> {
	const server = await startPlanReviewServer({ htmlContent: MINIMAL_HTML, origin: "pi", ...options });
	try {
		return await body(server);
	} finally {
		server.stop();
	}
}

async function approveWith(modelSwitch: unknown) {
	const plan = newPlan();
	return withServer({ plan, models: CATALOG, currentModel: CURRENT }, async (server) => {
		const response = await fetch(`${server.url}/api/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				planSave: { enabled: false },
				...(modelSwitch === undefined ? {} : { modelSwitch }),
			}),
		});
		expect(response.status).toBe(200);
		return await server.waitForDecision();
	});
}

describe("pi plan /api/models", () => {
	test("serves the catalog and the model in effect", async () => {
		await withServer({ plan: newPlan(), models: CATALOG, currentModel: CURRENT }, async (server) => {
			const response = await fetch(`${server.url}/api/models`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ models: CATALOG, current: CURRENT });
		});
	});

	test("a host with no catalog serves empty lists, which hides the picker", async () => {
		await withServer({ plan: newPlan() }, async (server) => {
			const response = await fetch(`${server.url}/api/models`);
			expect(await response.json()).toEqual({ models: [], current: null });
		});
	});
});

describe("pi plan /api/approve modelSwitch", () => {
	test("the reviewer's pick reaches the decision", async () => {
		const pick = CATALOG[1];
		const decision = await approveWith(pick);
		expect(decision.approved).toBe(true);
		expect(decision.modelSwitch).toEqual(pick);
	});

	test("an approval without a pick carries none, so the phase config decides", async () => {
		const decision = await approveWith(undefined);
		expect(decision.approved).toBe(true);
		expect(decision.modelSwitch).toBeUndefined();
	});

	test("a pick missing provider or id is refused rather than half-applied", async () => {
		for (const malformed of ["anthropic/claude-opus-4", { id: "claude-opus-4" }, { provider: "", id: "x" }, null]) {
			const decision = await approveWith(malformed);
			expect(decision.modelSwitch).toBeUndefined();
		}
	});

	test("a pick without a name still applies, using the id as the label", async () => {
		const decision = await approveWith({ provider: "google", id: "gemini-2.5-flash" });
		expect(decision.modelSwitch).toEqual({ provider: "google", id: "gemini-2.5-flash", name: "gemini-2.5-flash" });
	});
});

describe("pi plan approval origin guard", () => {
	for (const origin of ["https://foreign.example", "null"]) {
		test(`rejects ${origin} before parsing or claiming the decision`, async () => {
			await withServer({ plan: newPlan() }, async (server) => {
				let decided = false;
				server.onDecision(() => { decided = true; });
				const response = await fetch(`${server.url}/api/approve`, {
					method: "POST", headers: { Origin: origin }, body: "not json",
				});
				expect(response.status).toBe(403);
				expect(decided).toBe(false);
				expect(server.updatePlan(newPlan())).not.toBeNull();
				const accepted = await fetch(`${server.url}/api/approve`, {
					method: "POST", headers: { Origin: new URL(server.url).origin, "Content-Type": "application/json" },
					body: JSON.stringify({ planSave: { enabled: false } }),
				});
				expect(accepted.status).toBe(200);
				expect((await server.waitForDecision()).approved).toBe(true);
			});
		});
	}
});

test("browser catalog is opt-in; legacy sessions and blocking callers keep it hidden", async () => {
	const html = spyOn(browserRuntime, "getPlanBrowserHtml").mockReturnValue(MINIMAL_HTML);
	const browser = spyOn(network, "openBrowser").mockResolvedValue({ opened: true });
	const getAvailable = spyOn({ getAvailable: () => CATALOG }, "getAvailable");
	const ctx = { hasUI: true, model: CURRENT, modelRegistry: { getAvailable }, ui: { notify() {} } } as never;
	try {
		for (const modelPicker of [undefined, false, true]) {
			const session = await startPlanReviewBrowserSession(ctx, newPlan(), undefined, { modelPicker });
			try {
				const response = await fetch(`${session.url}/api/models`);
				expect(await response.json()).toEqual(modelPicker ? { models: CATALOG, current: CURRENT } : { models: [], current: null });
			} finally { session.stop(); }
		}
		expect(getAvailable).toHaveBeenCalledTimes(1);
		// The legacy wrapper has no opt-in argument. Capture its URL to settle it.
		let url = "";
		browser.mockImplementation(async (openedUrl) => { url = openedUrl; return { opened: true }; });
		const decision = openPlanReviewBrowser(ctx, newPlan());
		for (let i = 0; i < 50 && !url; i++) await new Promise(resolve => setTimeout(resolve, 5));
		expect(url).not.toBe("");
		expect(await (await fetch(`${url}/api/models`)).json()).toEqual({ models: [], current: null });
		await fetch(`${url}/api/approve`, { method: "POST", body: JSON.stringify({ planSave: { enabled: false } }) });
		expect((await decision).approved).toBe(true);
		expect(getAvailable).toHaveBeenCalledTimes(1);
	} finally {
		html.mockRestore();
		browser.mockRestore();
		getAvailable.mockRestore();
	}
});
