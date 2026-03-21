const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { transformLiveUsageData, loadAnthropicScrapeFallback } = require("../src/llm-usage");

describe("llm-usage module", () => {
  describe("loadAnthropicScrapeFallback()", () => {
    it("loads Claude widget data from the scraped cache file", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-usage-"));
      const file = path.join(tmpDir, "anthropic-usage.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          timestamp: "2026-03-20T22:30:50.548Z",
          claude: {
            session: { usedPct: 9, remainingPct: 91, resetsIn: "29 m" },
            weekly: { usedPct: 1, remainingPct: 99, resets: "Fri 11:00 AM" },
            sonnet: { usedPct: 1, remainingPct: 99, resets: "Fri 1:00 PM" },
            lastSynced: "2026-03-20T22:30:50.549Z",
          },
          scrape: { ok: true },
          fetch: { source: "openclaw-browser" },
        }),
      );

      const result = loadAnthropicScrapeFallback(file);
      assert.strictEqual(result.source, "scraped");
      assert.strictEqual(result.claude.session.usedPct, 9);
      assert.strictEqual(result.claude.weekly.resets, "Fri 11:00 AM");
      assert.strictEqual(result.fetch.source, "openclaw-browser");
    });
  });

  describe("transformLiveUsageData()", () => {
    it("transforms valid usage data with anthropic provider", () => {
      const usage = {
        providers: [
          {
            provider: "anthropic",
            windows: [
              { label: "5h", usedPercent: 25, resetAt: Date.now() + 3600000 },
              { label: "Week", usedPercent: 10, resetAt: Date.now() + 86400000 * 3 },
              { label: "Sonnet", usedPercent: 5, resetAt: Date.now() + 86400000 * 5 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.claude.session.usedPct, 25);
      assert.strictEqual(result.claude.session.remainingPct, 75);
      assert.strictEqual(result.claude.weekly.usedPct, 10);
      assert.strictEqual(result.claude.sonnet.usedPct, 5);
    });

    it("handles auth error from provider while preserving codex data", () => {
      const usage = {
        providers: [
          { provider: "anthropic", error: "403 Forbidden" },
          {
            provider: "openai-codex",
            windows: [
              { label: "5h", usedPercent: 49, resetAt: Date.now() + 3600000 },
              { label: "Week", usedPercent: 74, resetAt: Date.now() + 86400000 * 3 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "error");
      assert.strictEqual(result.errorType, "auth");
      assert.ok(result.error.includes("403"));
      assert.strictEqual(result.claude.session.usedPct, null);
      assert.strictEqual(result.codex.usage5hPct, 49);
      assert.strictEqual(result.codex.usageDayPct, 74);
    });

    it("handles missing windows gracefully", () => {
      const usage = { providers: [{ provider: "anthropic", windows: [] }] };
      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.claude.session.usedPct, 0);
      assert.strictEqual(result.claude.weekly.usedPct, 0);
    });

    it("handles codex provider data", () => {
      const usage = {
        providers: [
          { provider: "anthropic", windows: [] },
          {
            provider: "openai-codex",
            windows: [
              { label: "5h", usedPercent: 30 },
              { label: "Day", usedPercent: 15 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.codex.usage5hPct, 30);
      assert.strictEqual(result.codex.usageDayPct, 15);
    });

    it("accepts Week as the codex weekly window label", () => {
      const usage = {
        providers: [
          { provider: "anthropic", windows: [] },
          {
            provider: "openai-codex",
            windows: [
              { label: "5h", usedPercent: 49 },
              { label: "Week", usedPercent: 74 },
            ],
          },
        ],
      };

      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.codex.usage5hPct, 49);
      assert.strictEqual(result.codex.usageDayPct, 74);
    });

    it("handles missing providers gracefully", () => {
      const usage = { providers: [] };
      const result = transformLiveUsageData(usage);
      assert.strictEqual(result.source, "live");
      assert.strictEqual(result.codex.usage5hPct, 0);
    });

    it("formats reset time correctly", () => {
      const usage = {
        providers: [
          {
            provider: "anthropic",
            windows: [{ label: "5h", usedPercent: 50, resetAt: Date.now() + 30 * 60000 }],
          },
        ],
      };
      const result = transformLiveUsageData(usage);
      assert.ok(result.claude.session.resetsIn.includes("m"));
    });
  });
});
