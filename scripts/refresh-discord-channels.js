#!/usr/bin/env node
/**
 * Created/maintained by Clawbaby.
 * Purpose: Refresh the Discord channel name cache used by Command Center for session labels.
 *          Fetches guild channels + resolves known active thread/forum-post IDs.
 *          Command Center reads this cache at startup — no live Discord API calls needed.
 * Added: 2026-03-22.
 *
 * Usage: node scripts/refresh-discord-channels.js [--guild-id ID] [--config PATH]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const HOME = os.homedir();
const DEFAULT_CACHE_PATH = path.join(HOME, ".openclaw", "state", "discord-channel-cache.json");
const DEFAULT_FAILED_IDS_PATH = DEFAULT_CACHE_PATH.replace(".json", ".failed-ids.json");
const TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = { configPath: null, cacheOutput: DEFAULT_CACHE_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") args.configPath = argv[++i];
    if (argv[i] === "--cache-output") args.cacheOutput = argv[++i];
  }
  return args;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function runOcl(args) {
  return execFileSync("openclaw", args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

function formatLabel(name = "", type = 0, id = "") {
  if (!name) return `#${id.slice(-8)}`;
  const needsHash = [0, 5, 15].includes(Number(type));
  return needsHash ? (name.startsWith("#") ? name : `#${name}`) : name;
}

function loadOpenClawConfig(configPath) {
  const dirs = configPath
    ? [configPath]
    : [
        path.join(HOME, ".openclaw", "openclaw.json"),
        path.join(HOME, ".openclaw", "config.json"),
      ];
  for (const p of dirs) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {}
  }
  return null;
}

function getGuildIds(config) {
  const accounts = config?.channels?.discord?.accounts || {};
  const ids = new Set([
    ...Object.keys(config?.channels?.discord?.guilds || {}),
    ...Object.values(accounts).flatMap((a) => Object.keys(a?.guilds || {})),
  ]);
  return [...ids];
}

function fetchGuildChannels(guildId) {
  try {
    const out = runOcl([
      "message", "channel", "list",
      "--channel", "discord",
      "--guild-id", guildId,
      "--json",
    ]);
    const start = out.indexOf("{");
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
    return parsed?.payload?.channels || [];
  } catch (e) {
    console.error(`[refresh-discord] guild ${guildId} fetch failed: ${e.message}`);
    return [];
  }
}

function fetchForumThreads(guildId, forumChannelId, accounts) {
  // Use openclaw message thread list per forum channel, trying each bot account
  const threads = new Map();
  for (const account of accounts) {
    try {
      const out = runOcl([
        "message", "thread", "list",
        "--channel", "discord",
        "--guild-id", guildId,
        "--channel-id", forumChannelId,
        "--account", account,
        "--json",
      ]);
      const start = out.indexOf("{");
      const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
      const raw = parsed?.payload?.threads;
      const list = (typeof raw === "object" && !Array.isArray(raw)) ? (raw?.threads || []) : (raw || []);
      for (const t of Array.isArray(list) ? list : []) {
        if (!threads.has(t.id)) threads.set(t.id, t);
      }
    } catch {
      // Skip accounts that don't have access
    }
  }
  return [...threads.values()];
}

function fetchChannelInfoWithAccounts(channelId, accounts) {
  for (const account of accounts) {
    try {
      const out = runOcl([
        "message", "channel", "info",
        "--channel", "discord",
        "--account", account,
        "--target", `channel:${channelId}`,
        "--json",
      ]);
      const start = out.indexOf("{");
      const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
      const c = parsed?.payload?.channel;
      if (c?.name) return c;
    } catch {}
  }
  return null;
}

function fetchChannelInfo(channelId) {
  try {
    const out = runOcl([
      "message", "channel", "info",
      "--channel", "discord",
      "--target", `channel:${channelId}`,
      "--json",
    ]);
    const start = out.indexOf("{");
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
    return parsed?.payload?.channel || null;
  } catch {
    return null;
  }
}

function getAccountNames(config) {
  return Object.keys(config?.channels?.discord?.accounts || {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadOpenClawConfig(args.configPath);
  if (!config) {
    console.error("[refresh-discord] Could not load OpenClaw config");
    process.exit(1);
  }

  const guildIds = getGuildIds(config);
  if (!guildIds.length) {
    console.error("[refresh-discord] No guild IDs found in config");
    process.exit(1);
  }

  const accounts = getAccountNames(config);

  // Load existing cache (to preserve thread entries and failed IDs)
  const existing = readJson(args.cacheOutput) || { fetchedAt: 0, channels: {} };
  const failedIds = new Set(readJson(DEFAULT_FAILED_IDS_PATH) || []);
  const channels = { ...(existing.channels || {}) };

  // 1. Fetch all guild channels (one call per guild — very cheap)
  let guildChannelCount = 0;
  const forumChannelIds = [];
  for (const guildId of guildIds) {
    const list = fetchGuildChannels(guildId);
    for (const c of list) {
      channels[c.id] = {
        guildId,
        channelLabel: formatLabel(c.name, c.type, c.id),
        parentId: c.parent_id || null,
        type: c.type,
        updatedAt: Date.now(),
      };
      guildChannelCount++;
      // Collect forum channels (type 15) to fetch their threads
      if (Number(c.type) === 15) forumChannelIds.push({ id: c.id, guildId });
    }
  }
  console.log(`[refresh-discord] Guild channels fetched: ${guildChannelCount}, forums: ${forumChannelIds.length}`);

  // 2. Fetch active threads inside each forum channel, trying all bot accounts
  let threadCount = 0;
  for (const { id: forumId, guildId } of forumChannelIds) {
    const threads = fetchForumThreads(guildId, forumId, accounts);
    for (const t of threads) {
      const label = formatLabel(t.name, t.type, t.id);
      if (!channels[t.id] || channels[t.id].channelLabel !== label) {
        channels[t.id] = {
          guildId,
          channelLabel: label,
          parentId: t.parent_id || forumId,
          type: t.type,
          updatedAt: Date.now(),
        };
        threadCount++;
      }
    }
  }
  console.log(`[refresh-discord] Forum threads discovered/updated: ${threadCount}`);

  // 3. Refresh names for known thread IDs in cache (in case they were renamed)
  const knownThreadIds = Object.entries(channels)
    .filter(([, v]) => v.type && [11, 12].includes(Number(v.type)))
    .map(([id]) => id);

  let refreshed = 0;
  for (const id of knownThreadIds) {
    if (failedIds.has(id)) continue;
    const c = fetchChannelInfoWithAccounts(id, accounts);
    if (c?.name) {
      channels[id] = {
        ...channels[id],
        channelLabel: formatLabel(c.name, c.type, id),
        parentId: c.parent_id || channels[id]?.parentId || null,
        updatedAt: Date.now(),
      };
      refreshed++;
    } else if (c === null) {
      failedIds.add(id);
    }
  }
  console.log(`[refresh-discord] Thread names refreshed: ${refreshed}`);

  // 3. Write updated cache
  const cache = { fetchedAt: Date.now(), channels };
  writeJson(args.cacheOutput, cache);
  writeJson(DEFAULT_FAILED_IDS_PATH, [...failedIds]);

  console.log(`[refresh-discord] Cache written: ${Object.keys(channels).length} total entries → ${args.cacheOutput}`);
}

main().catch((e) => {
  console.error("[refresh-discord]", e.message);
  process.exit(1);
});
