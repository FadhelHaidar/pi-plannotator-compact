/**
 * readFileCapped / readRepoFile (repo-file.ts): the cap is checked before
 * reading, and a directory is refused as not a file. The FIFO probe runs in a
 * child process with a parent-enforced deadline, so a blocking-read regression
 * fails here instead of hanging this process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileCapped, readRepoFile } from "./repo-file";

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pn-repo-file-unit-"));
	writeFileSync(join(dir, "ten.txt"), "0123456789");
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("readFileCapped", () => {
	test("reads a file exactly at the cap and refuses one byte over, with its size", async () => {
		expect(await readFileCapped(join(dir, "ten.txt"), { maxBytes: 10 })).toMatchObject({ ok: true, content: "0123456789" });
		expect(await readFileCapped(join(dir, "ten.txt"), { maxBytes: 9 })).toMatchObject({
			ok: false,
			reason: "too-large",
			size: 10,
			maxBytes: 9,
		});
	});

	test("refuses a directory as not a file", async () => {
		expect(await readFileCapped(dir)).toMatchObject({ ok: false, reason: "not-a-file" });
	});
});

describe("readRepoFile", () => {
	test("keeps the path string checks: absolute, .. and NUL are invalid; a missing file is not found", async () => {
		for (const path of ["/etc/hosts", "../ten.txt", "a/../ten.txt", "ten.txt\0", ""]) {
			expect(await readRepoFile(dir, path)).toMatchObject({ ok: false, reason: "invalid-path" });
		}
		expect(await readRepoFile(dir, "nope.txt")).toMatchObject({ ok: false, reason: "not-found" });
		expect(await readRepoFile(dir, "ten.txt")).toMatchObject({ ok: true, content: "0123456789" });
	});
});

describe("repo-file on a FIFO", () => {
	test.skipIf(process.platform === "win32")(
		"a FIFO is refused without blocking the reader",
		() => {
			execFileSync("mkfifo", [join(dir, "pipe")]);
			// A blocking open would hang the child; the deadline kills it and fails the expect.
			const child = spawnSync(
				process.execPath,
				[
					"-e",
					`const { readRepoFile } = await import(${JSON.stringify(new URL("./repo-file.ts", import.meta.url).pathname)});
					 const result = await readRepoFile(${JSON.stringify(dir)}, "pipe");
					 console.log(result.ok ? "read" : result.reason);`,
				],
				{ timeout: 10_000, encoding: "utf8" },
			);
			expect(child.stdout.trim()).toBe("not-a-file");
		},
	);
});
