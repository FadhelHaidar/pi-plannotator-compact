import { describe, test, expect } from "bun:test";
import { SessionManager } from "./session-manager.ts";
import { buildSystemPrompt, buildForkPreamble } from "./context.ts";
import {
  ProviderRegistry,
  registerProviderFactory,
  createProvider,
} from "./provider.ts";
import {
  AI_ENDPOINT_PATHS,
  createAIEndpoints,
  createBestEffortOnce,
} from "./endpoints.ts";
import type {
  AIProvider,
  AISession,
  AIMessage,
  AIContext,
  CreateSessionOptions,
} from "./types.ts";
import {
  buildWindowsCommandScriptSpawnCommand,
  killWindowsProcessTree,
  planAgentJobSpawn,
  resolveCommandFromWhichOutput,
  resolveWindowsCommandShim,
  shouldSpawnViaShell,
} from "./providers/command-path.ts";

// ---------------------------------------------------------------------------
// Helpers — mock provider/session for testing
// ---------------------------------------------------------------------------

function mockSession(
  id: string,
  parentSessionId: string | null = null
): AISession {
  let active = false;
  return {
    get id() {
      return id;
    },
    parentSessionId,
    get isActive() {
      return active;
    },
    async *query(prompt: string): AsyncIterable<AIMessage> {
      active = true;
      yield { type: "text_delta", delta: `Echo: ${prompt}` };
      yield {
        type: "result",
        sessionId: id,
        success: true,
        result: `Echo: ${prompt}`,
      };
      active = false;
    },
    abort() {
      active = false;
    },
  };
}

let sessionCounter = 0;

function mockProvider(name = "mock"): AIProvider {
  return {
    name,
    capabilities: { fork: true, resume: true, streaming: true, tools: false },
    async createSession(opts) {
      return mockSession(`session-${++sessionCounter}`, null);
    },
    async forkSession(opts) {
      const parent = opts.context.parent;
      return mockSession(
        `forked-${++sessionCounter}`,
        parent?.sessionId ?? null
      );
    },
    async resumeSession(sessionId) {
      return mockSession(sessionId, null);
    },
    dispose() {},
  };
}

describe("createBestEffortOnce", () => {
  test("coalesces concurrent calls and caches completion", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = createBestEffortOnce(async () => {
      calls++;
      await gate;
    });

    const first = initialize();
    const second = initialize();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    await initialize();
    expect(calls).toBe(1);
  });

  test("swallows a failure and retries only once the cooldown has passed", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("discovery failed");
    };

    // Within the cooldown a broken tool is not re-spawned on every call…
    const cooled = createBestEffortOnce(failing, 60_000);
    await expect(cooled()).resolves.toBeUndefined();
    await expect(cooled()).resolves.toBeUndefined();
    expect(calls).toBe(1);

    // …but a failure never pins the fallback for the life of the process.
    calls = 0;
    const retrying = createBestEffortOnce(failing, 0);
    await retrying();
    await retrying();
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Command path helpers
// ---------------------------------------------------------------------------

describe("command path helpers", () => {
  test("resolveWindowsCommandShim prefers a sibling .cmd for npm shims", () => {
    const raw = String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi`;
    const resolved = resolveWindowsCommandShim(
      raw,
      "win32",
      (path) => path === `${raw}.cmd`,
    );

    expect(resolved).toBe(`${raw}.cmd`);
  });

  test("resolveCommandFromWhichOutput skips extensionless Windows shims", () => {
    const raw = String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi`;
    const resolved = resolveCommandFromWhichOutput(
      `${raw}\r\n${raw}.cmd\r\n`,
      "win32",
      () => false,
    );

    expect(resolved).toBe(`${raw}.cmd`);
  });

  test("resolveCommandFromWhichOutput preserves the first non-Windows result", () => {
    expect(
      resolveCommandFromWhichOutput("/usr/local/bin/pi\n/usr/bin/pi\n", "darwin"),
    ).toBe("/usr/local/bin/pi");
  });

  test("shouldSpawnViaShell only flags Windows command scripts", () => {
    expect(
      shouldSpawnViaShell(
        String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi.cmd`,
        "win32",
      ),
    ).toBe(true);
    expect(shouldSpawnViaShell(String.raw`C:\tools\pi.exe`, "win32")).toBe(false);
    expect(shouldSpawnViaShell("/usr/local/bin/pi.cmd", "darwin")).toBe(false);
  });

  test("buildWindowsCommandScriptSpawnCommand wraps command scripts for Bun.spawn", () => {
    const command = buildWindowsCommandScriptSpawnCommand(
      String.raw`C:\Users\Andrew Ramos\AppData\Roaming\npm\pi.cmd`,
      ["--mode", "rpc"],
      "win32",
      String.raw`C:\Windows\System32\cmd.exe`,
    );

    expect(command).toEqual([
      String.raw`C:\Windows\System32\cmd.exe`,
      "/d",
      "/s",
      "/c",
      String.raw`"C:\Users\Andrew Ramos\AppData\Roaming\npm\pi.cmd" --mode rpc`,
    ]);
  });

  test("buildWindowsCommandScriptSpawnCommand ignores native executables", () => {
    expect(
      buildWindowsCommandScriptSpawnCommand(
        String.raw`C:\tools\pi.exe`,
        ["--mode", "rpc"],
        "win32",
      ),
    ).toBeNull();
  });

  // #2372: Guided Review with Pi failed on Windows with `spawn pi ENOENT`:
  // the job launcher spawned the bare name, which Node cannot resolve to
  // Pi's pi.cmd. These simulate win32, as the Ask AI shim tests above do.
  describe("planAgentJobSpawn", () => {
    const piBin = String.raw`C:\Users\Andrew Ramos\.pi\agent\bin\pi`;
    const cmdExe = String.raw`C:\Windows\System32\cmd.exe`;
    const piOnPath = (name: string) => (name === "pi" ? piBin : null);
    const shimExists = (path: string) => path === `${piBin}.cmd`;
    const piPromptOnStdin = (argv: string[]) =>
      argv.at(-2) === "-p" ? { command: argv.slice(0, -1), stdin: argv.at(-1)! } : null;
    const prompt = 'Organize this diff.\n\n--- a/x.ts\n+++ b/x.ts\n+const s = "100% & | <done>";';
    const piJob = ["pi", "--mode", "json", "--no-session", "--exclude-tools", "edit,write", "--model", "openai/gpt-5.1", "-p", prompt];

    test("a .cmd shim found on PATH runs through cmd.exe, with the prompt moved to stdin", () => {
      const launch = planAgentJobSpawn(piJob, {
        which: piOnPath,
        promptOnStdin: piPromptOnStdin,
        platform: "win32",
        exists: shimExists,
        comspec: cmdExe,
      });

      expect(launch).toEqual({
        command: [
          cmdExe,
          "/d",
          "/s",
          "/c",
          String.raw`""C:\Users\Andrew Ramos\.pi\agent\bin\pi.cmd" "--mode" "json" "--no-session" "--exclude-tools" "edit,write" "--model" "openai/gpt-5.1" "-p""`,
        ],
        stdinPrompt: prompt,
        verbatim: true,
      });
    });

    test("where's .cmd line is used as found, and a job's own stdin prompt is kept", () => {
      const launch = planAgentJobSpawn(["claude", "-p", "--output-format", "stream-json"], {
        which: () => String.raw`C:\npm\claude.cmd`,
        stdinPrompt: "the prompt",
        promptOnStdin: () => {
          throw new Error("not asked: the job already reads its prompt from stdin");
        },
        platform: "win32",
        exists: () => false,
        comspec: cmdExe,
      });

      expect(launch.command.at(-1)).toBe(String.raw`""C:\npm\claude.cmd" "-p" "--output-format" "stream-json""`);
      expect(launch.stdinPrompt).toBe("the prompt");
    });

    // The failure: an argument cmd.exe would read (a quote, %VAR%, a line
    // break) reaches cmd.exe, which can run something the job never asked for.
    test("arguments cmd.exe would misread are never passed to it", () => {
      for (const arg of ['a"b', "%PATH%", "!x!", "a^b", "line\nbreak"]) {
        const launch = planAgentJobSpawn(["pi", "--model", arg, "-p"], {
          which: piOnPath,
          platform: "win32",
          exists: shimExists,
          comspec: cmdExe,
        });
        expect(launch.command).toEqual(["pi", "--model", arg, "-p"]);
        expect(launch.verbatim).toBe(false);
        expect(launch.unsafeScript).toContain(`${piBin}.cmd`);
      }
      // A prompt with no stdin route stays out of cmd.exe too.
      const noRoute = planAgentJobSpawn(piJob, { which: piOnPath, platform: "win32", exists: shimExists });
      expect(noRoute.command).toBe(piJob);
      expect(noRoute.unsafeScript).toBeDefined();
    });

    test("a trailing backslash is doubled so it cannot escape the closing quote", () => {
      const launch = planAgentJobSpawn(["pi", "--workspace", String.raw`C:\repo\ `.trim()], {
        which: piOnPath,
        platform: "win32",
        exists: shimExists,
        comspec: cmdExe,
      });
      expect(launch.command.at(-1)).toEndWith(String.raw`"--workspace" "C:\repo\\""`);
    });

    test("an .exe, a program not on PATH, and every other platform keep the command as built", () => {
      const asIs = (command: string[], launch: ReturnType<typeof planAgentJobSpawn>) =>
        expect(launch).toEqual({ command, stdinPrompt: undefined, verbatim: false });
      asIs(piJob, planAgentJobSpawn(piJob, { which: () => String.raw`C:\tools\pi.exe`, promptOnStdin: piPromptOnStdin, platform: "win32", exists: () => false }));
      asIs(piJob, planAgentJobSpawn(piJob, { which: () => null, promptOnStdin: piPromptOnStdin, platform: "win32", exists: shimExists }));
      asIs(piJob, planAgentJobSpawn(piJob, { which: () => "/usr/local/bin/pi", promptOnStdin: piPromptOnStdin, platform: "darwin", exists: () => true }));
      asIs(piJob, planAgentJobSpawn(piJob, { which: () => "/usr/bin/pi.cmd", promptOnStdin: piPromptOnStdin, platform: "linux", exists: () => true }));
    });
  });

  test("killWindowsProcessTree invokes taskkill with tree flags on Windows", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; windowsHide: boolean };
    }> = [];
    const killed = killWindowsProcessTree(1234, "win32", (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });

    expect(killed).toBe(true);
    expect(calls).toEqual([
      {
        command: "taskkill",
        args: ["/pid", "1234", "/t", "/f"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ]);
  });

  test("killWindowsProcessTree skips non-Windows platforms", () => {
    let called = false;
    const killed = killWindowsProcessTree(1234, "darwin", () => {
      called = true;
      return { status: 0 };
    });

    expect(killed).toBe(false);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  test("tracks sessions and lists them newest-first", () => {
    const sm = new SessionManager();
    const s1 = mockSession("s1");
    const s2 = mockSession("s2");

    const e1 = sm.track(s1, "plan-review", "First");
    const e2 = sm.track(s2, "code-review", "Second");
    e1.lastActiveAt = 1000;
    e2.lastActiveAt = 2000;

    expect(sm.size).toBe(2);
    const list = sm.list();
    expect(list[0].session.id).toBe("s2");
    expect(list[1].session.id).toBe("s1");
  });

  test("get returns entry by ID", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    expect(sm.get("s1")?.session.id).toBe("s1");
    expect(sm.get("nonexistent")).toBeUndefined();
  });

  test("touch updates lastActiveAt", async () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    const before = sm.get("s1")!.lastActiveAt;

    await new Promise((r) => setTimeout(r, 10));
    sm.touch("s1");

    expect(sm.get("s1")!.lastActiveAt).toBeGreaterThan(before);
  });

  test("remove removes entry", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    sm.remove("s1");
    expect(sm.size).toBe(0);
  });

  test("forksOf filters by parent", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    sm.track(mockSession("fork1", "parent-123"), "plan-review");
    sm.track(mockSession("fork2", "parent-123"), "plan-review");
    sm.track(mockSession("fork3", "other-parent"), "code-review");

    const forks = sm.forksOf("parent-123");
    expect(forks.length).toBe(2);
    expect(forks.map((f) => f.session.id).sort()).toEqual(["fork1", "fork2"]);
  });

  test("evicts oldest idle session when maxSessions reached", () => {
    const sm = new SessionManager({ maxSessions: 2 });
    sm.track(mockSession("s1"), "plan-review");
    sm.track(mockSession("s2"), "plan-review");
    sm.track(mockSession("s3"), "plan-review");

    expect(sm.size).toBe(2);
    expect(sm.get("s1")).toBeUndefined();
    expect(sm.get("s2")).toBeDefined();
    expect(sm.get("s3")).toBeDefined();
  });

  test("disposeAll aborts active sessions and clears", () => {
    const sm = new SessionManager();
    const s1 = mockSession("s1");
    sm.track(s1, "plan-review");
    sm.disposeAll();
    expect(sm.size).toBe(0);
  });

  test("remapId moves entry to new key and keeps alias", () => {
    const sm = new SessionManager();
    sm.track(mockSession("placeholder-1"), "plan-review");

    sm.remapId("placeholder-1", "real-sdk-id");

    // Both old and new IDs resolve to the same entry
    expect(sm.get("real-sdk-id")).toBeDefined();
    expect(sm.get("placeholder-1")).toBeDefined();
    expect(sm.get("placeholder-1")).toBe(sm.get("real-sdk-id"));
  });

  test("track wires onIdResolved callback with alias", () => {
    const sm = new SessionManager();
    const session = mockSession("temp-id");
    sm.track(session, "plan-review");

    expect(session.onIdResolved).toBeDefined();
    session.onIdResolved!("temp-id", "real-id");

    // Both IDs work
    expect(sm.get("real-id")).toBeDefined();
    expect(sm.get("temp-id")).toBeDefined();
    expect(sm.get("temp-id")).toBe(sm.get("real-id"));
  });

  test("remove cleans up aliases", () => {
    const sm = new SessionManager();
    sm.track(mockSession("temp"), "plan-review");
    sm.remapId("temp", "real");

    sm.remove("real");
    expect(sm.get("real")).toBeUndefined();
    expect(sm.get("temp")).toBeUndefined();
    expect(sm.size).toBe(0);
  });

  test("remove via alias also works", () => {
    const sm = new SessionManager();
    sm.track(mockSession("temp"), "plan-review");
    sm.remapId("temp", "real");

    sm.remove("temp"); // remove via alias
    expect(sm.get("real")).toBeUndefined();
    expect(sm.get("temp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

describe("Context builders", () => {
  test("buildSystemPrompt for plan-review", () => {
    const ctx: AIContext = {
      mode: "plan-review",
      plan: {
        plan: "# My Plan\n\nStep 1: do things",
        previousPlan: "# Old Plan",
        version: 3,
        totalVersions: 4,
        project: "plannotator",
      },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("# My Plan");
    expect(prompt).toContain("Step 1: do things");
    expect(prompt).toContain("Plan version: 3 of 4");
    expect(prompt).toContain("Project: plannotator");
    expect(prompt).toContain("# Old Plan");
  });

  test("buildSystemPrompt for code-review is role-only (diff rides on user messages)", () => {
    const ctx: AIContext = {
      mode: "code-review",
      review: { patch: "diff --git a/foo.ts b/foo.ts\n+hello", diffType: "branch", base: "main" },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("code changes");
    // The diff and how-to-inspect-it are delivered on the user's messages now
    // (the review server's shared machine builds them), not in the system prompt.
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toContain("git diff");
    expect(prompt).not.toContain("```diff");
  });

  test("buildSystemPrompt for annotate", () => {
    const ctx: AIContext = {
      mode: "annotate",
      annotate: {
        content: "# Doc\nSome content",
        filePath: "/tmp/test.md",
        sourceInfo: "https://example.com/doc.html",
        sourceConverted: true,
        renderAs: "html",
      },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("/tmp/test.md");
    expect(prompt).toContain("https://example.com/doc.html");
    expect(prompt).toContain("Render mode: html");
    expect(prompt).toContain("converted before annotation");
  });

  test("buildForkPreamble includes context and instructions", () => {
    const ctx: AIContext = {
      mode: "plan-review",
      plan: {
        plan: "# Plan\nDetails here",
        annotations: "- Remove section 3",
      },
      parent: { sessionId: "parent-123", cwd: "/project" },
    };
    const preamble = buildForkPreamble(ctx);
    expect(preamble).toContain("reviewing your work in Plannotator");
    expect(preamble).toContain("# Plan");
    expect(preamble).toContain("Remove section 3");
  });

  test("buildForkPreamble for code-review with selected code", () => {
    const ctx: AIContext = {
      mode: "code-review",
      review: {
        patch: "+new line",
        filePath: "src/auth.ts",
        selectedCode: "function verify()",
        lineRange: { start: 10, end: 15, side: "new" },
      },
      parent: { sessionId: "p", cwd: "/proj" },
    };
    const preamble = buildForkPreamble(ctx);
    expect(preamble).toContain("src/auth.ts");
    expect(preamble).toContain("function verify()");
    expect(preamble).toContain("Lines 10-15");
  });

  test("truncates very long plans", () => {
    const longPlan = "x".repeat(100_000);
    const ctx: AIContext = {
      mode: "plan-review",
      plan: { plan: longPlan },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("[truncated for context window]");
    expect(prompt.length).toBeLessThan(longPlan.length);
  });

  test("every mode instructs the agent to answer directly (no unprompted review)", () => {
    const modes: AIContext[] = [
      { mode: "plan-review", plan: { plan: "# Plan" } },
      { mode: "code-review", review: { patch: "+x" } },
      { mode: "annotate", annotate: { content: "# Doc", filePath: "/x.md" } },
    ];
    for (const ctx of modes) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain("Respond to the user's message directly");
      expect(prompt).toContain("do NOT review");
    }
  });

  test("code-review system prompt never carries the diff or a git command, for any diffType", () => {
    // The "changes under review" context moved to the user's messages (built by
    // the shared agent-review machine), so the system prompt must stay role-only
    // regardless of diff type — no pasted patch, no git command.
    const variants: AIContext[] = [
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker", diffType: "branch", base: "develop" } },
      { mode: "code-review", review: { patch: "+marker", diffType: "merge-base", base: "main" } },
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker", diffType: "jj-current" } },
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker" } },
    ];
    for (const ctx of variants) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain("marker");
      expect(prompt).not.toContain("```diff");
      expect(prompt).not.toContain("git diff");
    }
  });

  test("code-review system prompt tells the agent the changeset arrives in user messages", () => {
    const prompt = buildSystemPrompt({ mode: "code-review", review: { patch: "+x" } });
    expect(prompt).toMatch(/messages/i);
    expect(prompt).toMatch(/inspect/i);
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe("ProviderRegistry", () => {
  test("register, get, list, dispose", () => {
    const reg = new ProviderRegistry();
    const p = mockProvider("test-provider");
    reg.register(p);

    expect(reg.get("test-provider")).toBe(p);
    expect(reg.getDefault()?.provider).toBe(p);
    expect(reg.getDefault()?.id).toBe("test-provider");
    expect(reg.list()).toEqual(["test-provider"]);

    reg.dispose("test-provider");
    expect(reg.get("test-provider")).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  test("register with custom instance ID", () => {
    const reg = new ProviderRegistry();
    const p = mockProvider("claude-agent-sdk");
    const id = reg.register(p, "claude-fast");

    expect(id).toBe("claude-fast");
    expect(reg.get("claude-fast")).toBe(p);
    expect(reg.get("claude-agent-sdk")).toBeUndefined();
  });

  test("multiple instances of same provider type", () => {
    const reg = new ProviderRegistry();
    const p1 = mockProvider("claude-agent-sdk");
    const p2 = mockProvider("claude-agent-sdk");

    reg.register(p1, "claude-review");
    reg.register(p2, "claude-plan");

    expect(reg.size).toBe(2);
    expect(reg.get("claude-review")).toBe(p1);
    expect(reg.get("claude-plan")).toBe(p2);

    const byType = reg.getByType("claude-agent-sdk");
    expect(byType.length).toBe(2);
  });

  test("mixed provider types", () => {
    const reg = new ProviderRegistry();
    reg.register(mockProvider("claude-agent-sdk"), "claude-1");
    reg.register(mockProvider("opencode-sdk"), "oc-1");

    expect(reg.size).toBe(2);
    expect(reg.getByType("claude-agent-sdk").length).toBe(1);
    expect(reg.getByType("opencode-sdk").length).toBe(1);
  });

  test("disposeAll clears everything", () => {
    const reg = new ProviderRegistry();
    reg.register(mockProvider("a"));
    reg.register(mockProvider("b"));
    reg.disposeAll();
    expect(reg.size).toBe(0);
  });

  test("createProvider via factory (does not auto-register)", async () => {
    registerProviderFactory("test-factory", async (config) => {
      return mockProvider(config.type);
    });

    const provider = await createProvider({ type: "test-factory" });
    expect(provider.name).toBe("test-factory");

    // Should NOT be auto-registered in any registry
    const reg = new ProviderRegistry();
    expect(reg.get("test-factory")).toBeUndefined();
  });

  test("createProvider throws for unknown type", async () => {
    await expect(createProvider({ type: "unknown-xyz" })).rejects.toThrow(
      "No AI provider factory"
    );
  });
});

// ---------------------------------------------------------------------------
// AI endpoints
// ---------------------------------------------------------------------------

describe("AI endpoints", () => {
  function setup() {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });
    return { reg, sm, endpoints };
  }

  test("canonical path list matches the runtime endpoint map", () => {
    const { endpoints } = setup();

    expect([...AI_ENDPOINT_PATHS].sort()).toEqual(Object.keys(endpoints).sort());
  });

  test("capabilities returns available: false when no provider", async () => {
    const { endpoints } = setup();

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.available).toBe(false);
    expect(data.defaultProvider).toBeNull();
  });

  test("capabilities returns provider info when registered", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.available).toBe(true);
    expect(data.defaultProvider).toBe("mock");
    expect(data.providers.length).toBe(1);
    expect(data.providers[0].id).toBe("mock");
    expect(data.providers[0].name).toBe("mock");
    expect(data.providers[0].capabilities.fork).toBe(true);
  });

  test("capabilities does not activate providers", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    let activated = false;
    reg.register(mockProvider("codex-sdk"), "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async () => {
        activated = true;
      },
    });

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities"),
    );

    expect(res.status).toBe(200);
    expect(activated).toBe(false);
  });

  test("capabilities?activate= runs the provider initializer and reports refreshed models", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const activations: string[] = [];
    const provider = {
      ...mockProvider("codex-sdk"),
      models: [{ id: "static-model", label: "Static", default: true }],
    };
    reg.register(provider, "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async (providerId) => {
        activations.push(providerId);
        provider.models = [
          { id: "discovered-model", label: "Discovered", default: true },
        ];
      },
    });

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities?activate=codex"),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(activations).toEqual(["codex"]);
    expect(data.providers[0].models).toEqual([
      { id: "discovered-model", label: "Discovered", default: true },
    ]);
  });

  test("capabilities?activate= ignores unknown provider ids", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    let activated = false;
    reg.register(mockProvider("codex-sdk"), "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async () => {
        activated = true;
      },
    });

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities?activate=missing"),
    );

    expect(res.status).toBe(200);
    expect(activated).toBe(false);
  });

  test("capabilities waits for pending provider discovery", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const provider = mockProvider("pi-sdk") as AIProvider & {
      models?: Array<{ id: string; label: string; default?: boolean }>;
    };
    reg.register(provider);
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeCapabilities: async () => {
        provider.models = [{ id: "pi/model", label: "Pi Model", default: true }];
      },
    });

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.providers[0].models).toEqual([
      { id: "pi/model", label: "Pi Model", default: true },
    ]);
  });

  test("capabilities lists multiple providers", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-1");
    reg.register(mockProvider("opencode-sdk"), "oc-1");

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.providers.length).toBe(2);
    const ids = data.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("claude-1");
    expect(ids).toContain("oc-1");
  });

  test("capabilities returns instance ID not type name for defaultProvider", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-fast");

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    // Should return the instance ID "claude-fast", not the type name "claude-agent-sdk"
    expect(data.defaultProvider).toBe("claude-fast");
  });

  test("session creation and query flow", async () => {
    const { reg, sm, endpoints } = setup();
    reg.register(mockProvider("mock"));

    // Create session
    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const createData = (await createRes.json()) as { sessionId: string };
    expect(createData.sessionId).toBeDefined();
    expect(sm.size).toBe(1);

    // Query
    const queryRes = await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: createData.sessionId,
          prompt: "What is this plan about?",
        }),
      })
    );
    expect(queryRes.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await queryRes.text();
    expect(text).toContain("Echo: What is this plan about?");
    expect(text).toContain("[DONE]");
  });

  test("session creation with specific provider ID", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-fast");
    reg.register(mockProvider("opencode-sdk"), "oc-default");

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "claude-fast",
        }),
      })
    );
    expect(createRes.status).toBe(200);
  });

  test("session creation activates only the resolved provider before createSession", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const events: string[] = [];
    reg.register(mockProvider("claude-agent-sdk"), "claude");
    reg.register({
      ...mockProvider("codex-sdk"),
      async createSession() {
        events.push("create");
        return mockSession(`session-${++sessionCounter}`, null);
      },
    }, "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async (providerId) => {
        events.push(`activate:${providerId}`);
      },
    });

    const res = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "codex",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(events).toEqual(["activate:codex", "create"]);
  });

  test("session creation replaces the static default with the discovered default", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    let createdModel: string | undefined;
    const provider = {
      ...mockProvider("codex-sdk"),
      models: [{ id: "static-model", label: "Static", default: true }],
      async createSession(options: CreateSessionOptions) {
        createdModel = options.model;
        return mockSession(`session-${++sessionCounter}`, null);
      },
    };
    reg.register(provider, "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async () => {
        provider.models = [
          { id: "discovered-model", label: "Discovered", default: true },
        ];
      },
    });

    const res = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "codex",
          model: "static-model",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(createdModel).toBe("discovered-model");
  });

  test("session creation honors a requested model the provider still offers", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    let createdModel: string | undefined;
    const provider = {
      ...mockProvider("codex-sdk"),
      models: [{ id: "static-model", label: "Static", default: true }],
      async createSession(options: CreateSessionOptions) {
        createdModel = options.model;
        return mockSession(`session-${++sessionCounter}`, null);
      },
    };
    reg.register(provider, "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async () => {
        provider.models = [
          { id: "discovered-default", label: "Default", default: true },
          { id: "discovered-alt", label: "Alt" },
        ];
      },
    });

    const res = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "codex",
          model: "discovered-alt",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(createdModel).toBe("discovered-alt");
  });

  test("session creation snaps an unlisted model to the discovered default on every session", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const createdModels: Array<string | undefined> = [];
    const provider = {
      ...mockProvider("codex-sdk"),
      models: [{ id: "static-model", label: "Static", default: true }],
      async createSession(options: CreateSessionOptions) {
        createdModels.push(options.model);
        return mockSession(`session-${++sessionCounter}`, null);
      },
    };
    reg.register(provider, "codex");
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeProviderSession: async () => {
        provider.models = [
          { id: "discovered-model", label: "Discovered", default: true },
        ];
      },
    });

    // Two sessions with the stale pre-discovery fallback id: the second one
    // runs after activation already happened, and must not pin the stale id
    // just because it no longer matches the pre-activation default.
    for (let i = 0; i < 2; i++) {
      const res = await endpoints["/api/ai/session"](
        new Request("http://localhost/api/ai/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { mode: "plan-review", plan: { plan: "# Test" } },
            providerId: "codex",
            model: "static-model",
          }),
        }),
      );
      expect(res.status).toBe(200);
    }

    expect(createdModels).toEqual(["discovered-model", "discovered-model"]);
  });

  test("session creation passes the requested model through when the provider reports no models", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    let createdModel: string | undefined;
    reg.register({
      ...mockProvider("mock"),
      async createSession(options: CreateSessionOptions) {
        createdModel = options.model;
        return mockSession(`session-${++sessionCounter}`, null);
      },
    });

    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });
    const res = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          model: "anything-goes",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(createdModel).toBe("anything-goes");
  });

  test("session creation forwards only an effort the resolved model accepts", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const efforts: Array<string | undefined> = [];
    reg.register({
      ...mockProvider("claude-agent-sdk"),
      models: [
        { id: "sonnet", label: "Sonnet", default: true, reasoningEfforts: [{ id: "high", label: "High" }] },
        { id: "haiku", label: "Haiku" },
      ],
      async createSession(options: CreateSessionOptions) {
        efforts.push(options.reasoningEffort);
        return mockSession(`session-${++sessionCounter}`, null);
      },
    }, "claude");
    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });

    for (const [model, reasoningEffort] of [["sonnet", "high"], ["sonnet", "ultra"], ["haiku", "high"]]) {
      const res = await endpoints["/api/ai/session"](
        new Request("http://localhost/api/ai/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { mode: "plan-review", plan: { plan: "# Test" } },
            providerId: "claude",
            model,
            reasoningEffort,
          }),
        }),
      );
      expect(res.status).toBe(200);
    }

    // A level the model lists passes; one it does not list, or any level on a
    // model that takes none, is dropped rather than sent to the CLI.
    expect(efforts).toEqual(["high", undefined, undefined]);
  });

  test("session creation clamps client-supplied cost controls", async () => {
    const { reg, endpoints } = setup();
    let seenOptions: { maxTurns?: number; maxBudgetUsd?: number } | null = null;
    reg.register({
      ...mockProvider("mock"),
      async createSession(opts) {
        seenOptions = opts;
        return mockSession(`session-${++sessionCounter}`, null);
      },
    });

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          maxTurns: 9999,
          maxBudgetUsd: 9999,
        }),
      })
    );

    expect(createRes.status).toBe(200);
    expect(seenOptions?.maxTurns).toBe(99);
    expect(seenOptions?.maxBudgetUsd).toBe(5);
  });

  test("session creation fails for unknown provider ID", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "nonexistent",
        }),
      })
    );
    expect(createRes.status).toBe(503);
    const data = await createRes.json();
    expect(data.error).toContain("nonexistent");
  });

  test("query with context update prepends to prompt", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const queryRes = await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          prompt: "What changed?",
          contextUpdate: "New annotation: section 3 flagged",
        }),
      })
    );
    const text = await queryRes.text();
    expect(text).toContain("Context update");
    expect(text).toContain("section 3 flagged");
    expect(text).toContain("What changed?");
  });

  test("query sets label from first prompt", async () => {
    const { reg, sm, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // First query should set the label
    await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          prompt: "Why did we choose this approach?",
        }),
      })
    );

    const entry = sm.get(sessionId);
    expect(entry?.label).toBe("Why did we choose this approach?");
  });

  test("abort endpoint", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const abortRes = await endpoints["/api/ai/abort"](
      new Request("http://localhost/api/ai/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
    );
    const abortData = (await abortRes.json()) as { ok: boolean };
    expect(abortData.ok).toBe(true);
  });

  test("sessions list endpoint", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# A" } },
        }),
      })
    );
    await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "code-review", review: { patch: "+x" } },
        }),
      })
    );

    const listRes = await endpoints["/api/ai/sessions"](
      new Request("http://localhost/api/ai/sessions")
    );
    const sessions = (await listRes.json()) as Array<{ mode: string }>;
    expect(sessions.length).toBe(2);
  });
});
