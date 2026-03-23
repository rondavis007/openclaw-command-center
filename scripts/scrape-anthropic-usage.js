#!/usr/bin/env node
/**
 * Created/maintained by Clawbaby.
 * Purpose: Scrape Anthropic usage via OpenClaw's authenticated browser profile and cache normalized usage data for Command Center.
 * Added: 2026-03-20. Updated: 2026-03-20 to use the real browser-authenticated path instead of raw HTTP fetch.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseAnthropicUsageHtml } = require("../src/anthropic-usage-parser");

const DEFAULT_URL = process.env.ANTHROPIC_USAGE_URL || "https://claude.ai/settings/usage";
const DEFAULT_OUTPUT =
  process.env.ANTHROPIC_USAGE_OUTPUT ||
  path.join(__dirname, "..", "public", "data", "anthropic-usage.json");
const DEFAULT_PROFILE = process.env.ANTHROPIC_USAGE_BROWSER_PROFILE || "openclaw";
const DEFAULT_TIMEOUT_MS = Number(process.env.ANTHROPIC_USAGE_TIMEOUT_MS || 30000);

function getStatusPath(outputPath) {
  return outputPath.replace(/\.json$/i, ".status.json");
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    output: DEFAULT_OUTPUT,
    htmlFile: null,
    snapshotFile: null,
    browserProfile: DEFAULT_PROFILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    closeTab: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--html-file") args.htmlFile = argv[++i];
    else if (arg === "--snapshot-file") args.snapshotFile = argv[++i];
    else if (arg === "--browser-profile") args.browserProfile = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]) || args.timeoutMs;
    else if (arg === "--keep-tab-open") args.closeTab = false;
  }
  return args;
}

function writeJson(outputPath, data) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeSuccessCache(outputPath, payload) {
  const tempPath = `${outputPath}.tmp`;
  writeJson(tempPath, payload);
  fs.renameSync(tempPath, outputPath);
}

function writeStatus(outputPath, payload) {
  writeJson(getStatusPath(outputPath), payload);
}

function runOpenClaw(args, timeoutMs) {
  return execFileSync("openclaw", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 10,
  }).trim();
}

function extractTabId(openOutput) {
  const match = String(openOutput || "").match(/id:\s*([A-Z0-9]+)/i);
  return match ? match[1] : null;
}

function snapshotViaBrowser({ url, browserProfile, timeoutMs, closeTab }) {
  // Per-step timeouts: short ops get 15s, the wait-for-load gets most of the budget
  const shortMs = Math.min(15000, timeoutMs);
  const waitMs = Math.max(timeoutMs, 60000); // always at least 60s for the page load

  runOpenClaw(["browser", "--browser-profile", browserProfile, "start"], shortMs);
  const openOutput = runOpenClaw(
    ["browser", "--browser-profile", browserProfile, "open", url],
    shortMs,
  );
  const tabId = extractTabId(openOutput);

  try {
    if (tabId) {
      runOpenClaw(["browser", "--browser-profile", browserProfile, "focus", tabId], shortMs);
    }

    // Use fixed-time wait instead of networkidle — the latter times out intermittently
    // even when the page is fully loaded, because background activity keeps the network busy.
    runOpenClaw(
      ["browser", "--browser-profile", browserProfile, "wait", "--time", "4000"],
      shortMs,
    );

    const snapshot = runOpenClaw(
      ["browser", "--browser-profile", browserProfile, "snapshot", "--limit", "250"],
      shortMs,
    );

    return { snapshot, tabId };
  } finally {
    if (closeTab && tabId) {
      try {
        runOpenClaw(["browser", "--browser-profile", browserProfile, "close", tabId], timeoutMs);
      } catch {}
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let rawText = "";
  let fetchMeta = {
    source: null,
    url: args.url,
    finalUrl: args.url,
    browserProfile: args.browserProfile,
  };

  if (args.htmlFile) {
    rawText = fs.readFileSync(args.htmlFile, "utf8");
    fetchMeta.source = "html-file";
  } else if (args.snapshotFile) {
    rawText = fs.readFileSync(args.snapshotFile, "utf8");
    fetchMeta.source = "snapshot-file";
  } else {
    const { snapshot, tabId } = snapshotViaBrowser(args);
    rawText = snapshot;
    fetchMeta = {
      ...fetchMeta,
      source: "openclaw-browser",
      tabId,
    };
  }

  const parsed = parseAnthropicUsageHtml(rawText, { url: fetchMeta.finalUrl || fetchMeta.url });
  const payload = {
    ...parsed,
    fetch: fetchMeta,
    rawBytes: Buffer.byteLength(rawText, "utf8"),
  };

  if (!payload.scrape.ok) {
    writeStatus(args.output, payload);
    console.error(`[anthropic-usage] scrape failed; preserved last good cache at ${args.output}`);
    process.exitCode = 2;
    return;
  }

  writeSuccessCache(args.output, payload);
  writeStatus(args.output, {
    timestamp: payload.timestamp,
    source: payload.source,
    provider: payload.provider,
    scrape: payload.scrape,
    fetch: payload.fetch,
    cache: {
      path: args.output,
      updated: true,
    },
  });

  const summary = [
    `session=${payload.claude.session.usedPct ?? "?"}%`,
    `weekly=${payload.claude.weekly.usedPct ?? "?"}%`,
    `sonnet=${payload.claude.sonnet.usedPct ?? "?"}%`,
    `ok=${payload.scrape.ok}`,
    `source=${fetchMeta.source}`,
    `output=${args.output}`,
  ].join(" ");
  console.log(`[anthropic-usage] ${summary}`);

}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  const payload = {
    timestamp: new Date().toISOString(),
    source: "scraped",
    provider: "anthropic",
    scrape: {
      ok: false,
      extractedAt: new Date().toISOString(),
      error: error.message,
    },
    fetch: {
      source: "openclaw-browser",
      url: args.url,
      browserProfile: args.browserProfile,
    },
    cache: {
      path: args.output,
      preserved: fs.existsSync(args.output),
    },
  };
  try {
    writeStatus(args.output, payload);
  } catch {}
  console.error("[anthropic-usage]", error.message);
  process.exitCode = 1;
});
