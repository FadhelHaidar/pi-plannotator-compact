import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInstallSettled, packageUpdatedMessage, readPackageVersion } from "./package-version.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-package-"));
	dirs.push(dir);
	return dir;
}

function packageAt(dir: string, extra: Record<string, unknown> = {}): void {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", ...extra }));
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readPackageVersion", () => {
	test("reads a version and returns null for missing or malformed files", () => {
		const dir = tempDir();
		packageAt(dir);
		expect(readPackageVersion(join(dir, "package.json"))).toBe("1.2.3");
		writeFileSync(join(dir, "bad.json"), "{");
		expect(readPackageVersion(join(dir, "bad.json"))).toBeNull();
		expect(readPackageVersion(join(dir, "missing.json"))).toBeNull();
	});
});

describe("packageInstallSettled", () => {
	test("accepts a complete package with an entry and resolvable dependencies", () => {
		const dir = tempDir();
		packageAt(dir, { pi: { extensions: ["./"] }, dependencies: { dep: "^1.0.0" } });
		writeFileSync(join(dir, "index.ts"), "export {};\n");
		mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "dep", "package.json"), "{}");
		expect(packageInstallSettled(dir)).toBe(true);
	});

	test("rejects an install still missing its entry or a dependency", () => {
		const dir = tempDir();
		packageAt(dir, { pi: { extensions: ["./"] }, dependencies: { dep: "^1.0.0" } });
		expect(packageInstallSettled(dir)).toBe(false);
		writeFileSync(join(dir, "index.ts"), "export {};\n");
		expect(packageInstallSettled(dir)).toBe(false);
	});

	test("rejects while npm's retired copy sits beside the package", () => {
		const parent = tempDir();
		const dir = join(parent, "pkg");
		mkdirSync(dir);
		packageAt(dir, { pi: { extensions: ["./"] } });
		writeFileSync(join(dir, "index.ts"), "export {};\n");
		mkdirSync(join(parent, ".pkg-old"), { recursive: true });
		expect(packageInstallSettled(dir)).toBe(false);
	});
});

describe("packageUpdatedMessage", () => {
	test("names both versions, or says only that files changed", () => {
		expect(packageUpdatedMessage("1.0.0", "1.1.0")).toContain("from 1.0.0 to 1.1.0");
		expect(packageUpdatedMessage("1.0.0", "1.1.0")).toContain("/reload");
		expect(packageUpdatedMessage(null, "1.1.0")).toContain("files changed on disk");
	});
});
