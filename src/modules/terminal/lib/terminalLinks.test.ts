import { describe, expect, it } from "vitest";
import { findCandidates } from "./terminalLinks";

function pathTexts(text: string): string[] {
  return findCandidates(text)
    .filter((c) => c.kind === "path")
    .map((c) => c.text);
}

function urlTexts(text: string): string[] {
  return findCandidates(text)
    .filter((c) => c.kind === "url")
    .map((c) => c.text);
}

describe("terminalLinks.findCandidates", () => {
  it("matches relative paths with extensions", () => {
    expect(pathTexts("see seeds/v3-G-teamclaw-attack-rehearsal.md for details")).toEqual([
      "seeds/v3-G-teamclaw-attack-rehearsal.md",
    ]);
  });

  it("matches relative paths with line:col suffix", () => {
    expect(pathTexts("failed at src/foo.ts:42:10 here")).toEqual(["src/foo.ts:42:10"]);
  });

  it("matches absolute and home paths", () => {
    expect(
      pathTexts("edit /Users/zzh/proj/src/foo.ts and ~/.config/bar.toml"),
    ).toEqual(["/Users/zzh/proj/src/foo.ts", "~/.config/bar.toml"]);
  });

  it("matches ./ and ../ paths without extensions", () => {
    expect(pathTexts("run ./scripts/build then ../out/check")).toEqual([
      "./scripts/build",
      "../out/check",
    ]);
  });

  it("does not linkify dates or key/value pairs", () => {
    expect(pathTexts("date 2024/01/01 and key/value")).toEqual([]);
  });

  it("matches https urls and strips trailing punctuation", () => {
    expect(urlTexts("see https://example.com/path, and (https://x.io)")).toEqual([
      "https://example.com/path",
      "https://x.io",
    ]);
  });

  it("does not double-count a path that overlaps a url", () => {
    const c = findCandidates("see https://example.com/a/b.ts now");
    expect(c.filter((x) => x.kind === "path")).toEqual([]);
    expect(urlTexts("see https://example.com/a/b.ts now")).toEqual([
      "https://example.com/a/b.ts",
    ]);
  });

  it("matches Unicode (CJK) filenames", () => {
    expect(
      pathTexts("报告 允川-TeamClaw安全工作报告-v2-for-P10.md 完成"),
    ).toEqual(["允川-TeamClaw安全工作报告-v2-for-P10.md"]);
    expect(pathTexts("资金域_AntClawGuard干扰.sql")).toEqual([
      "资金域_AntClawGuard干扰.sql",
    ]);
  });

  it("matches bare filenames with extensions (the ls -l case)", () => {
    expect(
      pathTexts("-rw-r--r-- 1 zzh staff 144604 Jun 21 18:01 session.txt done"),
    ).toEqual(["session.txt"]);
  });

  it("requires an extension for slash-free and slash-relative paths", () => {
    // `key/value` and `2024/01/01` must NOT linkify.
    expect(pathTexts("split key/value and date 2024/01/01")).toEqual([]);
    // bare word without extension must not linkify either.
    expect(pathTexts("run build then deploy")).toEqual([]);
  });
});
