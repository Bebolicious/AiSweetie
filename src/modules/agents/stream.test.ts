import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatTokens,
  parseAgentLine,
  toolDetail,
} from "./stream";

const line = (o: unknown) => JSON.stringify(o);

describe("parseAgentLine", () => {
  it("reads the init event for model and tool count", () => {
    const [item] = parseAgentLine(
      line({ type: "system", subtype: "init", model: "sonnet", tools: ["Read", "Grep"] }),
    );
    expect(item).toEqual({ kind: "system", model: "sonnet", tools: 2 });
  });

  it("pulls prose out of an assistant message", () => {
    const items = parseAgentLine(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Looking at the diff.\n" }] },
      }),
    );
    expect(items).toEqual([{ kind: "text", text: "Looking at the diff." }]);
  });

  it("emits prose and tool calls from one message, in order", () => {
    const items = parseAgentLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading it." },
            { type: "tool_use", name: "Read", input: { file_path: "src/diff.rs" } },
          ],
        },
      }),
    );
    expect(items).toEqual([
      { kind: "text", text: "Reading it." },
      { kind: "tool", name: "Read", detail: "src/diff.rs" },
    ]);
  });

  it("marks a failed tool result", () => {
    const [item] = parseAgentLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", is_error: true, content: "ENOENT: no such file" },
          ],
        },
      }),
    );
    expect(item).toEqual({
      kind: "tool-result",
      ok: false,
      detail: "ENOENT: no such file",
    });
  });

  it("summarises a multi-line tool result without hiding its size", () => {
    const [item] = parseAgentLine(
      line({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "first\nsecond\nthird" }],
        },
      }),
    );
    // A Glob that matched three files must not read as if it matched one.
    expect(item).toMatchObject({ detail: "first  +2 more" });
  });

  it("leaves a single-line result unadorned", () => {
    const [item] = parseAgentLine(
      line({
        type: "user",
        message: { content: [{ type: "tool_result", content: "only\n" }] },
      }),
    );
    expect(item).toMatchObject({ detail: "only" });
  });

  it("ignores system events other than init, which carry no model or tools", () => {
    // These previously rendered as "unknown · 0 tools" in the transcript.
    expect(parseAgentLine(line({ type: "system", subtype: "compact" }))).toEqual(
      [],
    );
  });

  it("reads usage and cost off the result event", () => {
    const [item] = parseAgentLine(
      line({
        type: "result",
        subtype: "success",
        result: "Done.",
        duration_ms: 8200,
        total_cost_usd: 0.0142,
        usage: { input_tokens: 12000, output_tokens: 430 },
      }),
    );
    expect(item).toEqual({
      kind: "result",
      text: "Done.",
      inTokens: 12000,
      outTokens: 430,
      costUsd: 0.0142,
      durationMs: 8200,
    });
  });

  it("surfaces non-JSON output instead of dropping it", () => {
    const [item] = parseAgentLine("command not found: claude");
    expect(item).toEqual({ kind: "error", text: "command not found: claude" });
  });

  it("ignores blank lines", () => {
    expect(parseAgentLine("   ")).toEqual([]);
  });

  it("ignores event types it does not model", () => {
    expect(parseAgentLine(line({ type: "stream_event", delta: {} }))).toEqual([]);
  });
});

describe("toolDetail", () => {
  it("picks the argument that identifies each tool", () => {
    expect(toolDetail("Read", { file_path: "a.rs" })).toBe("a.rs");
    expect(toolDetail("Bash", { command: "cargo test" })).toBe("cargo test");
    expect(toolDetail("Grep", { pattern: "Spring::new" })).toBe("Spring::new");
    expect(toolDetail("WebFetch", { url: "https://x.dev" })).toBe("https://x.dev");
  });

  it("falls back sensibly for an unknown tool", () => {
    expect(toolDetail("Mystery", { path: "x" })).toBe("x");
    expect(toolDetail("Mystery", {})).toBe("");
  });
});

describe("formatting", () => {
  it("abbreviates token counts the way the mock does", () => {
    expect(formatTokens(430)).toBe("430");
    expect(formatTokens(8400)).toBe("8.4k");
    expect(formatTokens(84_000)).toBe("84k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(8_000)).toBe("8s");
    expect(formatElapsed(6 * 60_000)).toBe("6m");
    expect(formatElapsed(90 * 60_000)).toBe("1h 30m");
  });
});
