/**
 * The package was updated under a running Pi (#2085, #2356).
 *
 * An update replaces this package's files while Pi keeps the old modules
 * loaded. The version this module was evaluated with is recorded so the
 * auto-reload watcher can tell when the files on disk belong to a newer
 * version, and wait until npm has finished writing them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(PACKAGE_DIR, "package.json");

/** The `version` in a package.json, or null when it cannot be read. */
export function readPackageVersion(path: string = PACKAGE_JSON_PATH): string | null {
	try {
		const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
	} catch {
		return null;
	}
}

/**
 * Whether the install of the package in `dir` looks finished, so a reload
 * loads it whole. npm writes package.json first and the rest after it, in
 * parallel with changed dependencies; while it works, the replaced copy waits
 * beside the package as `.<name>-<hash>` and is deleted at the end. So: no
 * such copy, the extension's entry is on disk, and every dependency resolves
 * (a `node_modules/<dep>` in this folder or one above it).
 */
export function packageInstallSettled(dir: string = PACKAGE_DIR): boolean {
	let pkg: { pi?: { extensions?: unknown }; dependencies?: unknown };
	try {
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
	} catch {
		return false;
	}
	try {
		const retired = `.${basename(dir)}-`;
		if (readdirSync(dirname(dir)).some((name) => name.startsWith(retired))) return false;
	} catch {
		// The parent cannot be listed: no sign either way.
	}
	const entries = Array.isArray(pkg.pi?.extensions) ? (pkg.pi.extensions as unknown[]) : ["./"];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const path = resolve(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(path).isDirectory();
		} catch {
			return false;
		}
		if (isDir && !existsSync(join(path, "index.ts")) && !existsSync(join(path, "index.js"))) return false;
	}
	const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
	for (const dep of deps) if (!dependencyOnDisk(dir, dep)) return false;
	return true;
}

/** `node_modules/<dep>/package.json` in `dir` or a folder above it (Node's lookup). */
function dependencyOnDisk(dir: string, dep: string): boolean {
	let at = dir;
	for (;;) {
		if (existsSync(join(at, "node_modules", dep, "package.json"))) return true;
		const up = dirname(at);
		if (up === at) return false;
		at = up;
	}
}

/** The version of the code this process loaded, read when this module was evaluated. */
const LOADED_VERSION = readPackageVersion();

export function loadedPackageVersion(): string | null {
	return LOADED_VERSION;
}

/** The message for an update under a running Pi; without versions, a plain "files changed". */
export function packageUpdatedMessage(from: string | null, to: string | null): string {
	if (from && to && from !== to) {
		return `Plannotator was updated from ${from} to ${to} while Pi was running. Type /reload to load the new version.`;
	}
	return "Plannotator's files changed on disk while Pi was running. Type /reload to load the new version.";
}
