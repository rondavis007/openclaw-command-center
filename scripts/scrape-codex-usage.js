#!/usr/bin/env node
/**
 * Created/maintained by Clawbaby.
 * Purpose: Scrape OpenAI Codex usage via OpenClaw's authenticated browser profile and cache normalized usage data for Command Center.
 * Added: 2026-03-21.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseCodexUsageHtml } = require("../src/codex-usage-parser");

const DEFAULT_URL = process.env.CODEX_USAGE_URL || "https://chatgpt.com/codex/settings/usage";
const DEFAULT_OUTPUT =
  process.env.CODEX_USAGE_OUTPUT ||
  path.join(__dirname, "..", "public", "data", "codex-usage.json");
const DEFAULT_PROFILE = process.env.CODEX_USAGE_BROWSER_PROFILE || "openclaw";
const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_USAGE_TIMEOUT_MS || 30000);

function getStatusPath(outputPath) {
  return outputPath.replace(/\.json$/i, ".status.json");
}

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    output: DEFAULT_OUTPUT,
    mirrors: [],
    browserProfile: DEFAULT_PROFILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    closeTab: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--mirror") args.mirrors.push(argv[++i]);
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
  runOpenClaw(["browser", "--browser-profile", browserProfile, "start"], timeoutMs);
  const openOutput = runOpenClaw(
    ["browser", "--browser-profile", browserProfile, "open", url],
    timeoutMs,
  );
  const tabId = extractTabId(openOutput);

  try {
    if (tabId) {
      runOpenClaw(["browser", "--browser-profile", browserProfile, "focus", tabId], timeoutMs);
    }

    runOpenClaw(
      ["browser", "--browser-profile", browserProfile, "wait", "--load", "networkidle"],
      timeoutMs,
    );

    const snapshot = runOpenClaw(
      ["browser", "--browser-profile", browserProfile, "snapshot", "--limit", "250"],
      timeoutMs,
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
  const { snapshot, tabId } = snapshotViaBrowser(args);

  const fetchMeta = {
    source: "openclaw-browser",
    url: args.url,
    finalUrl: args.url,
    browserProfile: args.browserProfile,
    tabId,
  };

  const parsed = parseCodexUsageHtml(snapshot, { url: args.url });
  const payload = {
    ...parsed,
    fetch: fetchMeta,
    rawBytes: Buffer.byteLength(snapshot, "utf8"),
  };

  if (!payload.scrape.ok) {
    writeStatus(args.output, payload);
    console.error(`[codex-usage] scrape failed; preserved last good cache at ${args.output}`);
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
    cache: { path: args.output, updated: true },
  });

  // Write mirror copies (e.g. davisclaw-dashboard)
  for (const mirrorPath of args.mirrors) {
    try {
      writeSuccessCache(mirrorPath, payload);
    } catch (e) {
      console.error(`[codex-usage] mirror write failed (${mirrorPath}): ${e.message}`);
    }
  }

  const summary = [
    `hourly=${payload.codex.hourly.usedPct ?? "?"}%`,
    `weekly=${payload.codex.weekly.usedPct ?? "?"}%`,
    `credits=${payload.codex.credits ?? "?"}`,
    `resets=${payload.codex.weekly.resets ?? "?"}`,
    `ok=${payload.scrape.ok}`,
    `output=${args.output}`,
    ...(args.mirrors.length ? [`mirrors=${args.mirrors.length}`] : []),
  ].join(" ");
  console.log(`[codex-usage] ${summary}`);
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  const payload = {
    timestamp: new Date().toISOString(),
    source: "scraped",
    provider: "openai-codex",
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
  console.error("[codex-usage]", error.message);
  process.exitCode = 1;
});
