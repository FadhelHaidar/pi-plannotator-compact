/**
 * Tailscale helpers for remote-friendly sessions.
 *
 * One consumer: urlHost "auto" (PLANNOTATOR_URL_HOST=auto). Detect this
 * machine's tailnet host so remote sessions advertise a reachable URL without
 * the user hand-copying their MagicDNS name into config. Display-only, like
 * every urlHost value — binding stays governed by PLANNOTATOR_REMOTE.
 */

import { spawnSync } from "node:child_process";
import { isValidUrlHost } from "./config";

/** Detection commands answer from local state; keep the wait short. */
export const TAILSCALE_CLI_TIMEOUT_MS = 3_000;

/** The urlHost sentinel that requests tailnet host detection. */
export function isAutoUrlHost(host: string): boolean {
  return host.toLowerCase() === "auto";
}

/**
 * Extract this machine's MagicDNS name from `tailscale status --json` output.
 * Tailscale reports it FQDN-style with a trailing dot ("host.tail1234.ts.net.").
 */
export function parseTailscaleStatusDnsName(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const dnsName = (parsed as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName;
  if (typeof dnsName !== "string") return undefined;
  const host = dnsName.trim().replace(/\.+$/, "");
  return host !== "" && isValidUrlHost(host) ? host : undefined;
}

/** Strict CGNAT (100.64.0.0/10) IPv4 — the only range Tailscale assigns. */
export function parseTailscaleIpv4(value: string): string | undefined {
  const parts = value.trim().split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets[0] !== 100 || octets[1]! < 64 || octets[1]! > 127) return undefined;
  return octets.join(".");
}

/** `tailscale ip -4` output must contain exactly one valid tailnet address. */
export function parseTailscaleIpv4Output(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) return undefined;
  return parseTailscaleIpv4(lines[0]!);
}

export interface TailscaleRunResult {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: string[], timeoutMs: number) => TailscaleRunResult;

/** Run the `tailscale` CLI without a shell. */
export const runTailscale: TailscaleRunner = (args, timeoutMs) => {
  const result = spawnSync("tailscale", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    error: result.error ?? undefined,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** Turn a failed CLI invocation into one actionable sentence. */
export function describeTailscaleFailure(result: TailscaleRunResult): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "`tailscale` CLI not found on PATH. Install Tailscale (https://tailscale.com/download) and sign in with `tailscale up`.";
    }
    if (code === "ETIMEDOUT") {
      return "Timed out waiting for the `tailscale` CLI.";
    }
    return result.error.message;
  }
  const detail = result.stderr.trim();
  return `Tailscale is unavailable or not signed in.${detail ? ` ${detail}` : " Run `tailscale up` and retry."}`;
}

export type TailnetHostDetection = { host: string } | { error: string };

/**
 * Detect this machine's advertised tailnet host: MagicDNS name first
 * (`tailscale status --json` → `Self.DNSName`), single CGNAT IPv4 fallback
 * (`tailscale ip -4`). Never throws — callers surface `{ error }` as a
 * warning and fall back to localhost.
 */
export function detectTailnetHost(run: TailscaleRunner = runTailscale): TailnetHostDetection {
  const status = run(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error || status.status !== 0) {
    return { error: describeTailscaleFailure(status) };
  }
  const dnsName = parseTailscaleStatusDnsName(status.stdout);
  if (dnsName) return { host: dnsName };
  const ip = run(["ip", "-4"], TAILSCALE_CLI_TIMEOUT_MS);
  if (!ip.error && ip.status === 0) {
    const address = parseTailscaleIpv4Output(ip.stdout);
    if (address) return { host: address };
  }
  return {
    error: "Tailscale did not report a MagicDNS name or a single 100.64.0.0/10 IPv4 address.",
  };
}

/**
 * urlHost "auto": resolve this machine's tailnet host once per process.
 * Detection is display-only like every urlHost value; callers gate on
 * remote-session state before resolving, so a local session never spawns the
 * tailscale CLI. A failed detection warns once and resolves undefined
 * (callers advertise localhost); a display setting must never break a server
 * launch. Shared by the Bun runtime and the Pi mirror (vendored copy), each
 * process holding its own cache.
 */
let autoHostResolution: { host: string | undefined } | undefined;

export function resolveAutoHostCached(
  detect: (run?: TailscaleRunner) => TailnetHostDetection = detectTailnetHost,
): string | undefined {
  if (!autoHostResolution) {
    const result = detect();
    if ("host" in result) {
      autoHostResolution = { host: result.host };
    } else {
      autoHostResolution = { host: undefined };
      process.stderr.write(
        `[plannotator] Warning: advertised URL host "auto" could not resolve a tailnet host — ${result.error} Advertising localhost.\n`,
      );
    }
  }
  return autoHostResolution.host;
}
