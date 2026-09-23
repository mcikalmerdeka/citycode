import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "../lib/git/url";

describe("parseGitHubUrl", () => {
  it("accepts a plain https repo URL", () => {
    expect(parseGitHubUrl("https://github.com/vercel/next.js")).toEqual({
      owner: "vercel",
      repo: "next.js",
      name: "vercel/next.js",
      httpsUrl: "https://github.com/vercel/next.js",
    });
  });

  it("accepts a .git suffix", () => {
    const parsed = parseGitHubUrl("https://github.com/facebook/react.git");
    expect(parsed?.repo).toBe("react");
    expect(parsed?.httpsUrl).toBe("https://github.com/facebook/react");
  });

  it("accepts a trailing slash", () => {
    expect(parseGitHubUrl("https://github.com/a/b/")?.repo).toBe("b");
  });

  it("accepts www host", () => {
    expect(parseGitHubUrl("https://www.github.com/a/b")?.owner).toBe("a");
  });

  it("trims surrounding whitespace", () => {
    expect(parseGitHubUrl("  https://github.com/a/b \n")?.name).toBe("a/b");
  });

  it.each([
    "http://github.com/a/b" as const, // non-https: rejected per v1 scope
    "https://gitlab.com/a/b",
    "https://github.com/a", // missing repo
    "https://github.com/a/b/c", // too deep
    "https://github.com/a/b/tree/main", // not a repo root
    "",
    "not a url",
  ])("rejects %s", (input) => {
    expect(parseGitHubUrl(input)).toBeNull();
  });
});
