import { describe, expect, test } from "bun:test";
import { MARKER_ENGINES, markerClose, markerOpen } from "../generated/marker-review.ts";
import { parseTourMarkerOutput } from "../generated/tour-review.ts";

const nonce = "pn123456789abc";
const output = {
  title: "Tour",
  greeting: "Start here",
  intent: "Explain the change",
  before: "Before",
  after: "After",
  key_takeaways: [],
  stops: [{ title: "First", gist: "Summary", detail: "Details", transition: "Next", anchors: [] }],
  qa_checklist: [],
};

function stream(value: unknown): string {
  const text = `${markerOpen(nonce)}${JSON.stringify(value)}${markerClose(nonce)}`;
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

describe("parseTourMarkerOutput", () => {
  test("accepts the nonce-delimited Pi output with stops", () => {
    expect(parseTourMarkerOutput(stream(output), MARKER_ENGINES.pi, nonce)).toEqual(output);
  });

  test("fails closed for missing nonce, missing marker, or malformed output", () => {
    expect(parseTourMarkerOutput(stream(output), MARKER_ENGINES.pi, "")).toBeNull();
    expect(parseTourMarkerOutput("{}", MARKER_ENGINES.pi, nonce)).toBeNull();
    expect(parseTourMarkerOutput(stream({ ...output, stops: [] }), MARKER_ENGINES.pi, nonce)).toBeNull();
    expect(parseTourMarkerOutput(stream({ ...output, key_takeaways: undefined }), MARKER_ENGINES.pi, nonce)).toBeNull();
    expect(parseTourMarkerOutput(stream({ ...output, stops: [{ ...output.stops[0], anchors: [{ file: "a", line: "1" }] }] }), MARKER_ENGINES.pi, nonce)).toBeNull();
    expect(parseTourMarkerOutput(stream({ ...output, qa_checklist: [{ question: "Q?", stop_indices: [4] }] }), MARKER_ENGINES.pi, nonce)).toBeNull();
  });
});

describe("pi promptOnStdin", () => {
  // #2372: a Windows .cmd shim runs through cmd.exe, which cannot carry the
  // prompt's line breaks and quotes, so Pi's prompt moves to stdin.
  test("a -p <prompt> tail becomes stdin, and any other argv is left alone", () => {
    const prompt = 'Organize this diff.\n\n+const s = "100% & | <done>";';
    const argv = MARKER_ENGINES.pi.buildArgv(prompt, "openai/gpt-5.1", "/repo");
    expect(argv.slice(-2)).toEqual(["-p", prompt]);
    expect(MARKER_ENGINES.pi.promptOnStdin!(argv)).toEqual({ command: argv.slice(0, -1), stdin: prompt });
    expect(MARKER_ENGINES.pi.promptOnStdin!(["pi", "--list-models"])).toBeNull();
    expect(MARKER_ENGINES.pi.promptOnStdin!(["pi"])).toBeNull();
  });
});
