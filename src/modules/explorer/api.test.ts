import { describe, expect, it } from "vitest";
import { fuzzyMatch, humanSize, parentOf, relativeTime } from "./api";

describe("humanSize", () => {
  it("scales through the units", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(18_600)).toBe("18 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("keeps one decimal only below 10, where it carries information", () => {
    expect(humanSize(1024 * 9.5)).toBe("9.5 KB");
    expect(humanSize(1024 * 42)).toBe("42 KB");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("describes recent times in the unit a person would use", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(24 * 3_600_000)).toBe("yesterday");
    expect(ago(3 * 24 * 3_600_000)).toBe("3d ago");
    expect(ago(14 * 24 * 3_600_000)).toBe("2w ago");
  });

  it("renders a missing timestamp as an em dash, not 1970", () => {
    expect(relativeTime(0, now)).toBe("—");
  });
});

describe("fuzzyMatch", () => {
  it("matches a subsequence, not just a prefix", () => {
    expect(fuzzyMatch("dfv", "diff_view.rs")).toBe(true);
    expect(fuzzyMatch("mux", "term/mux.rs")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(fuzzyMatch("RS", "diff.rs")).toBe(true);
  });

  it("rejects when the characters are out of order", () => {
    expect(fuzzyMatch("vfd", "diff_view.rs")).toBe(false);
  });

  it("treats an empty needle as matching everything", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
  });
});

describe("parentOf", () => {
  it("walks up a Windows path", () => {
    expect(parentOf("C:\\Users\\me\\project")).toBe("C:\\Users\\me");
  });

  it("keeps the separator on a drive root", () => {
    expect(parentOf("C:\\Users")).toBe("C:\\");
  });

  it("walks up a POSIX path", () => {
    expect(parentOf("/home/me/project")).toBe("/home/me");
  });

  it("returns null at the top, so the UI can hide the .. row", () => {
    expect(parentOf("/")).toBeNull();
  });

  it("ignores a trailing separator", () => {
    expect(parentOf("/home/me/")).toBe("/home");
  });
});
