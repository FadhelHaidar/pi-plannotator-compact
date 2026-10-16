import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as browserRuntime from "./plannotator-browser-runtime.ts";
import {
	PLANNOTATOR_REQUEST_CHANNEL,
	PLANNOTATOR_REVIEW_RESULT_CHANNEL,
	registerPlannotatorEventListeners,
	writeReviewStatusesAtomically,
	type PlannotatorRequest,
	type PlannotatorRequestMap,
	type PlannotatorResponseMap,
} from "./plannotator-events.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";

const tempDirs: string[] = [];
afterEach(() => {
	mock.restore();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function statusPath(): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "plannotator-events-"));
	tempDirs.push(dir);
	return join(dir, "review-status.json");
}

function createHarness(reviewStatusPath: string, options: { uniqueReviews?: boolean; waitForStart?: Promise<void> } = {}) {
	let handleRequest!: (data: PlannotatorRequest) => Promise<void>;
	let startSession!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	let shutdownSession!: typeof startSession;
	const reviews: Array<{
		decide: (result: PlanReviewDecision) => void;
		claimed: boolean;
		actions: string[];
		unsubscribe: ReturnType<typeof mock>;
	}> = [];
	let decide!: (result: PlanReviewDecision) => void;
	const emit = mock(() => undefined);
	const pi = {
		on: (name: string, handler: typeof startSession) => {
			if (name === "session_start") startSession = handler;
			if (name === "session_shutdown") shutdownSession = handler;
		},
		events: {
			on: (name: string, handler: typeof handleRequest) => {
				if (name === PLANNOTATOR_REQUEST_CHANNEL) handleRequest = handler;
			},
			emit,
		},
	};
	spyOn(browserRuntime, "loadPlannotatorBrowser").mockResolvedValue({
		startPlanReviewBrowserSession: async () => {
			const review = { decide: (_result: PlanReviewDecision) => {}, claimed: false, actions: [] as string[], unsubscribe: mock(() => undefined) };
			reviews.push(review);
			const reviewId = options.uniqueReviews ? `review-${reviews.length}` : "new-review";
			await options.waitForStart;
			return {
				reviewId,
				onDecision: (listener: typeof decide) => {
					decide = listener;
					review.decide = listener; // Can simulate an already-queued callback after unsubscribe.
					return review.unsubscribe;
				},
				closeKeepingDraft: () => {
					review.actions.push("close");
					return review.claimed ? { closed: false, reason: "decided" } : { closed: true, unsentAnnotations: 0 };
				},
				stop: () => { review.actions.push("stop"); },
			};
		},
	} as never);
	registerPlannotatorEventListeners(pi as unknown as ExtensionAPI, { reviewStatusPath });

	async function request<A extends "plan-review" | "review-status">(
		action: A,
		payload: PlannotatorRequestMap[A]["payload"],
	): Promise<PlannotatorResponseMap[A]> {
		let response!: PlannotatorResponseMap[A];
		await handleRequest({
			requestId: "request-1", action, payload,
			respond: (value: PlannotatorResponseMap[A]) => { response = value; },
		} as PlannotatorRequest);
		return response;
	}

	return {
		emit,
		reviews,
		shutdown: () => shutdownSession({}, {} as ExtensionContext),
		start: () => startSession({}, {} as ExtensionContext),
		open: () => request("plan-review", { planContent: "Review this plan" }),
		query: (reviewId: string) => request("review-status", { reviewId }),
		decide: (result: PlanReviewDecision) => decide(result),
	};
}

describe("plannotator event review-status persistence", () => {
	test("a missing store initializes, and pending/completed updates preserve other reviews", async () => {
		const path = join(dirname(statusPath()), "nested", "status.json");
		const harness = createHarness(path);
		expect(await harness.query("new-review")).toEqual({ status: "handled", result: { status: "missing" } });
		expect(fs.existsSync(path)).toBe(false);
		await harness.start();
		expect(await harness.open()).toEqual({ status: "handled", result: { status: "pending", reviewId: "new-review" } });
		expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual({ "new-review": { status: "pending" } });

		const existing = { status: "completed" as const, reviewId: "older-review", approved: false, feedback: "Keep me" };
		writeReviewStatusesAtomically(path, { "older-review": existing });
		await harness.open();
		expect(await harness.query("older-review")).toEqual({ status: "handled", result: existing });
		expect(await harness.query("new-review")).toEqual({ status: "handled", result: { status: "pending" } });
		harness.decide({ approved: true, feedback: "Ready" });
		expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual({
			"older-review": existing,
			"new-review": { status: "completed", reviewId: "new-review", approved: true, feedback: "Ready" },
		});
		expect(await harness.query("new-review")).toEqual({
			status: "handled", result: { status: "completed", reviewId: "new-review", approved: true, feedback: "Ready" },
		});
	});

	test.each(['{"older-review":', "[]", "null", "42", '"not a store"'])(
		"preserves malformed store %s and skips pending/completed writes with logging",
		async (raw) => {
			const path = statusPath();
			fs.writeFileSync(path, raw);
			const log = spyOn(console, "error").mockImplementation(() => undefined);
			const write = spyOn(fs, "writeFileSync");
			const harness = createHarness(path);
			expect(await harness.query("older-review")).toEqual({ status: "handled", result: { status: "missing" } });
			await harness.start();
			expect((await harness.open()).status).toBe("handled");
			harness.decide({ approved: false });
			expect(fs.readFileSync(path, "utf-8")).toBe(raw);
			expect(write).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(2);
			expect(log.mock.calls[0][0]).toContain("Skipping review status write; preserving unreadable store");
			expect(harness.emit).toHaveBeenCalledWith(PLANNOTATOR_REVIEW_RESULT_CHANNEL, expect.objectContaining({ approved: false }));
		},
	);

	test("an unreadable existing store is not treated as missing", async () => {
		const path = statusPath();
		const raw = '{"older-review":{"status":"pending"}}';
		fs.writeFileSync(path, raw);
		const read = spyOn(fs, "readFileSync").mockImplementation(() => {
			throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		});
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		const write = spyOn(fs, "writeFileSync");
		const harness = createHarness(path);
		expect(await harness.query("older-review")).toEqual({ status: "handled", result: { status: "missing" } });
		await harness.start();
		expect((await harness.open()).status).toBe("handled");
		harness.decide({ approved: true });
		expect(write).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(2);
		read.mockRestore();
		expect(fs.readFileSync(path, "utf-8")).toBe(raw);
	});
});

describe("writeReviewStatusesAtomically", () => {
	test("writes complete JSON to a same-directory temp before atomically replacing the target", () => {
		const path = statusPath();
		const raw = '{"old":{"status":"pending"}}';
		fs.writeFileSync(path, raw);
		const statuses = { replacement: { status: "pending" as const } };
		const renameSync = fs.renameSync;
		const rename = spyOn(fs, "renameSync").mockImplementation((source, target) => {
			expect(dirname(String(source))).toBe(dirname(path));
			expect(source).not.toBe(path);
			expect(target).toBe(path);
			expect(fs.readFileSync(path, "utf-8")).toBe(raw);
			expect(JSON.parse(fs.readFileSync(source, "utf-8"))).toEqual(statuses);
			if (process.platform !== "win32") expect(fs.statSync(source).mode & 0o777).toBe(0o600);
			renameSync(source, target);
		});
		writeReviewStatusesAtomically(path, statuses);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fs.readFileSync(path, "utf-8"))).toEqual(statuses);
		expect(fs.readdirSync(dirname(path))).toEqual(["review-status.json"]);
	});

	test.each(["write", "rename"])("cleans temp after a failed %s and preserves the target and primary error", (operation) => {
		const path = statusPath();
		const raw = '{"old":{"status":"pending"}}';
		fs.writeFileSync(path, raw);
		const failure = new Error(`Injected ${operation} failure`);
		if (operation === "write") {
			const writeFileSync = fs.writeFileSync;
			spyOn(fs, "writeFileSync").mockImplementation((tempPath) => {
				writeFileSync(tempPath, '{"partial":');
				throw failure;
			});
		} else {
			spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
		}
		expect(() => writeReviewStatusesAtomically(path, { next: { status: "pending" } })).toThrow(failure);
		expect(fs.readFileSync(path, "utf-8")).toBe(raw);
		expect(fs.readdirSync(dirname(path))).toEqual(["review-status.json"]);
	});

	test("a cleanup failure does not mask the original rename failure", () => {
		const path = statusPath();
		const raw = '{"old":{"status":"pending"}}';
		fs.writeFileSync(path, raw);
		const failure = new Error("Injected rename failure");
		spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
		spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("Injected cleanup failure"); });
		expect(() => writeReviewStatusesAtomically(path, { next: { status: "pending" } })).toThrow(failure);
		expect(fs.readFileSync(path, "utf-8")).toBe(raw);
	});
});


describe("event plan reviews close with their session", () => {
	test.each(["shutdown", "replacement"])("%s closes every pending review, but not completed ones", async (reason) => {
		const harness = createHarness(statusPath(), { uniqueReviews: true });
		await harness.start();
		await harness.open();
		harness.reviews[0]!.decide({ approved: true });
		await harness.open();
		await harness.open();
		if (reason === "shutdown") await harness.shutdown();
		else await harness.start();
		expect(harness.reviews[0]!.actions).toEqual([]);
		expect((await harness.query("review-1"))).toMatchObject({ result: { status: "completed", approved: true } });
		for (const [index, review] of harness.reviews.entries()) {
			if (!index) continue;
			expect(review.actions).toEqual(["close", "stop"]);
			expect(review.unsubscribe).toHaveBeenCalledTimes(1);
			review.decide({ approved: false });
			expect(await harness.query(`review-${index + 1}`)).toEqual({ status: "handled", result: { status: "closed" } });
		}
		expect(harness.emit).toHaveBeenCalledTimes(1); // Only the genuine completed decision.
		await harness.shutdown();
		expect(harness.reviews[1]!.actions).toEqual(["close", "stop"]);
		expect((await harness.open()).status).toBe("unavailable");
	});

	test.each(["shutdown", "replacement"])("a review still starting during %s closes without a result", async (reason) => {
		let release!: () => void;
		const waitForStart = new Promise<void>((resolve) => { release = resolve; });
		const harness = createHarness(statusPath(), { waitForStart });
		await harness.start();
		const opening = harness.open();
		if (reason === "shutdown") await harness.shutdown();
		else await harness.start();
		release();
		expect((await opening).status).toBe("handled");
		expect(harness.reviews[0]!.actions).toEqual(["close", "stop"]);
		expect(await harness.query("new-review")).toEqual({ status: "handled", result: { status: "closed" } });
		harness.decide({ approved: true });
		expect(harness.emit).not.toHaveBeenCalled();
	});

	test("a claimed decision wins shutdown and persists completed rather than closed", async () => {
		const harness = createHarness(statusPath());
		await harness.start();
		await harness.open();
		harness.reviews[0]!.claimed = true;
		await harness.shutdown();
		expect(harness.reviews[0]!.actions).toEqual(["close"]);
		expect(await harness.query("new-review")).toEqual({ status: "handled", result: { status: "pending" } });
		harness.decide({ approved: true });
		expect(await harness.query("new-review")).toMatchObject({ result: { status: "completed", approved: true } });
		expect(harness.emit).toHaveBeenCalledTimes(1);
	});
});
