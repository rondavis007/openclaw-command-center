const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseAnthropicUsageHtml } = require("../src/anthropic-usage-parser");

describe("anthropic usage parser", () => {
  it("extracts session, weekly, and sonnet usage from normalized page text", () => {
    const html = `
      <main>
        <section>Session 25% used resets in 3h</section>
        <section>Weekly All Models 10% used resets in 4d</section>
        <section>Weekly Sonnet 5% used resets in 6d</section>
      </main>
    `;

    const result = parseAnthropicUsageHtml(html, { url: "https://claude.ai/settings/usage" });

    assert.strictEqual(result.source, "scraped");
    assert.strictEqual(result.claude.session.usedPct, 25);
    assert.strictEqual(result.claude.session.remainingPct, 75);
    assert.match(result.claude.session.resetsIn, /3h/i);
    assert.strictEqual(result.claude.weekly.usedPct, 10);
    assert.strictEqual(result.claude.sonnet.usedPct, 5);
    assert.strictEqual(result.scrape.ok, true);
  });

  it("understands remaining percentage phrasing", () => {
    const html = `
      <div>5h 70% left resets in 2h</div>
      <div>Week 90% left resets in 6d</div>
    `;

    const result = parseAnthropicUsageHtml(html);
    assert.strictEqual(result.claude.session.usedPct, 30);
    assert.strictEqual(result.claude.weekly.usedPct, 10);
  });

  it("extracts weekday-style reset timestamps", () => {
    const html = `
      <div>All models Resets Fri 11:00 AM 1% used</div>
      <div>Sonnet only Resets Fri 1:00 PM 1% used</div>
    `;

    const result = parseAnthropicUsageHtml(html);
    assert.match(result.claude.weekly.resets, /Fri 11:00 AM/i);
    assert.match(result.claude.sonnet.resets, /Fri 1:00 PM/i);
  });

  it("returns scrape.ok false when nothing useful is found", () => {
    const result = parseAnthropicUsageHtml("<html><body>No usage data here</body></html>");
    assert.strictEqual(result.scrape.ok, false);
    assert.strictEqual(result.claude.session.usedPct, null);
    assert.strictEqual(result.claude.weekly.usedPct, null);
  });
});
