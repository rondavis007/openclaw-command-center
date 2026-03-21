const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const script = path.join(__dirname, "..", "scripts", "scrape-anthropic-usage.js");

describe("scrape-anthropic-usage script", () => {
  it("writes cache on success", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-scrape-success-"));
    const htmlFile = path.join(dir, "sample.html");
    const outputFile = path.join(dir, "anthropic-usage.json");

    fs.writeFileSync(
      htmlFile,
      `<section>Session 25% used resets in 3h</section><section>Weekly All Models 10% used resets in 4d</section>`,
    );

    execFileSync("node", [script, "--html-file", htmlFile, "--output", outputFile], {
      encoding: "utf8",
    });

    const result = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    assert.strictEqual(result.scrape.ok, true);
    assert.strictEqual(result.claude.session.usedPct, 25);
  });

  it("preserves last good cache on parse failure and writes a status file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-scrape-failure-"));
    const htmlFile = path.join(dir, "bad.html");
    const outputFile = path.join(dir, "anthropic-usage.json");
    const statusFile = path.join(dir, "anthropic-usage.status.json");

    fs.writeFileSync(htmlFile, `<html><body>no usable usage data</body></html>`);
    fs.writeFileSync(
      outputFile,
      JSON.stringify({ claude: { session: { usedPct: 17 } }, scrape: { ok: true } }, null, 2),
    );

    let failed = false;
    try {
      execFileSync("node", [script, "--html-file", htmlFile, "--output", outputFile], {
        encoding: "utf8",
      });
    } catch (error) {
      failed = true;
    }

    assert.strictEqual(failed, true);
    const cache = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.strictEqual(cache.claude.session.usedPct, 17);
    assert.strictEqual(status.scrape.ok, false);
  });
});
