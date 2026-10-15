/**
 * Parser for the `claude` CLI's stream-json output.
 *
 * One JSON object per line. This turns those into transcript items the UI can
 * render directly, so the view never reasons about the wire format.
 */

export type Item =
  | { kind: "system"; model: string; tools: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "tool-result"; ok: boolean; detail: string }
  | {
      kind: "result";
      text: string;
      inTokens: number;
      outTokens: number;
      costUsd: number;
      durationMs: number;
    }
  | { kind: "error"; text: string };

/** A one-line summary of a tool call — the argument that identifies it. */
export function toolDetail(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input?.[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return pick("file_path", "path", "notebook_path");
    case "Bash":
      return pick("command");
    case "Grep":
      return pick("pattern");
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    default:
      return pick("file_path", "path", "pattern", "command", "url", "prompt");
  }
}

function textFrom(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("")
    .trim();
}

export function parseAgentLine(line: string): Item[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON at all — surface it rather than dropping it silently.
    return line.trim() ? [{ kind: "error", text: line.trim() }] : [];
  }

  const type = event.type;

  if (type === "stderr") {
    return [{ kind: "error", text: String(event.text ?? "") }];
  }

  // Only the init event carries model and tool list. Other `system` events
  // (compaction notices and the like) would otherwise render as
  // "unknown · 0 tools".
  if (type === "system") {
    if (event.subtype !== "init") return [];
    return [
      {
        kind: "system",
        model: String(event.model ?? "unknown"),
        tools: Array.isArray(event.tools) ? event.tools.length : 0,
      },
    ];
  }

  if (type === "assistant") {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const items: Item[] = [];

    const prose = textFrom(content);
    if (prose) items.push({ kind: "text", text: prose });

    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b?.type === "tool_use") {
        const name = String(b.name ?? "tool");
        items.push({
          kind: "tool",
          name,
          detail: toolDetail(name, (b.input ?? {}) as Record<string, unknown>),
        });
      }
    }
    return items;
  }

  if (type === "user") {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content
      .filter(
        (b): b is { type: "tool_result"; is_error?: boolean; content?: unknown } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "tool_result",
      )
      .map((b) => {
        const raw =
          typeof b.content === "string" ? b.content : textFrom(b.content);
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        const first = lines[0]?.slice(0, 120) ?? "";
        // A Glob that found 12 files should not read as if it found one.
        const detail =
          lines.length > 1 ? `${first}  +${lines.length - 1} more` : first;
        return { kind: "tool-result" as const, ok: !b.is_error, detail };
      });
  }

  if (type === "result") {
    const usage = (event.usage ?? {}) as Record<string, number>;
    return [
      {
        kind: "result",
        text: String(event.result ?? ""),
        inTokens: Number(usage.input_tokens ?? 0),
        outTokens: Number(usage.output_tokens ?? 0),
        costUsd: Number(event.total_cost_usd ?? 0),
        durationMs: Number(event.duration_ms ?? 0),
      },
    ];
  }

  return [];
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
