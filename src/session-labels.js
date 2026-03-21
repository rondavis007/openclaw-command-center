/**
 * Created/maintained by Clawbaby.
 * Purpose: Human-readable session labels for Command Center — mirrors ClawSpy's approach.
 * Resolves Discord channel IDs → names via OpenClaw CLI (env-expanded tokens), cron UUIDs → job names.
 * Added: 2026-03-20.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const DISCORD_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const DISCORD_CACHE_PATH = path.join(HOME, ".openclaw", "state", "discord-channel-cache.json");

// Known guild IDs — populated by the caller
let _guildIds = ["1471930469141446718"];

// ── Discord channel cache ──────────────────────────────────────────────────

function formatDiscordChannelLabel(rawName = "", type = 0, channelId = "") {
  if (!rawName) return `#${channelId.slice(-8)}`;
  const needsHash = [0, 5, 15].includes(Number(type));
  if (needsHash) return rawName.startsWith("#") ? rawName : `#${rawName}`;
  return rawName;
}

function readChannelCache() {
  try {
    return JSON.parse(fs.readFileSync(DISCORD_CACHE_PATH, "utf8"));
  } catch {
    return { fetchedAt: 0, channels: {} };
  }
}

function writeChannelCache(cache) {
  try {
    fs.mkdirSync(path.dirname(DISCORD_CACHE_PATH), { recursive: true });
    fs.writeFileSync(DISCORD_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

let _fetchInProgress = false;
// IDs that previously failed lookup (deleted/inaccessible) — skip retrying these
const _lookupFailedIds = new Set();

// Pre-populate from disk so thread names survive restarts
const _extraCache = (() => {
  try {
    const disk = readChannelCache();
    const extra = {};
    for (const [id, meta] of Object.entries(disk.channels || {})) {
      if (meta.type && [11, 12].includes(Number(meta.type))) extra[id] = meta;
    }
    return extra;
  } catch { return {}; }
})();

function _persistExtraToCache(id, meta) {
  try {
    const disk = readChannelCache();
    if (!disk.channels) disk.channels = {};
    disk.channels[id] = meta;
    writeChannelCache(disk);
  } catch {}
}

async function refreshDiscordChannelCache(openclawConfig) {
  if (_fetchInProgress) return;
  _fetchInProgress = true;
  try {
    // Derive guild IDs from config
    const accounts = openclawConfig?.channels?.discord?.accounts || {};
    const guildIds = [
      ...Object.keys(openclawConfig?.channels?.discord?.guilds || {}),
      ...Object.values(accounts).flatMap((a) => Object.keys(a?.guilds || {})),
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    if (guildIds.length) _guildIds = guildIds;

    const channels = {};
    for (const guildId of _guildIds) {
      try {
        // Use openclaw CLI so env-expanded Discord tokens are used
        const out = execFileSync(
          "openclaw",
          ["message", "channel", "list", "--channel", "discord", "--guild-id", guildId, "--json"],
          { encoding: "utf8", timeout: 15000 },
        );
        const jsonStart = out.indexOf("{");
        const parsed = JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out);
        const list = parsed?.payload?.channels || [];
        for (const c of list) {
          channels[c.id] = {
            guildId,
            channelLabel: formatDiscordChannelLabel(c.name, c.type, c.id),
            parentId: c.parent_id || null,
            type: c.type,
          };
        }
      } catch (e) {
        console.error("[session-labels] channel list failed for guild", guildId, e.message);
      }
    }

    if (Object.keys(channels).length) {
      writeChannelCache({ fetchedAt: Date.now(), channels });
      console.log(`[session-labels] Discord channel cache updated: ${Object.keys(channels).length} channels`);
    }
  } catch (e) {
    console.error("[session-labels] Discord cache refresh failed:", e.message);
  } finally {
    _fetchInProgress = false;
  }
}

async function getDiscordChannelMetadata(openclawConfig) {
  const cached = readChannelCache();
  const fresh = Date.now() - Number(cached.fetchedAt || 0) < DISCORD_CACHE_TTL_MS;
  if (!fresh) refreshDiscordChannelCache(openclawConfig).catch(() => {});
  return cached.channels && Object.keys(cached.channels).length ? cached.channels : {};
}

async function resolveUnknownChannels(sessionKeys, openclawConfig, channelMetadata) {
  const ids = [
    ...new Set(
      sessionKeys
        .map((k) =>
          k.includes(":discord:channel:")
            ? k.split(":discord:channel:")[1]?.split(":")[0]
            : null,
        )
        .filter(Boolean),
    ),
  ];

  const unknownIds = ids.filter((id) => {
    if (_lookupFailedIds.has(id)) return false;
    const inGuild = channelMetadata[id]?.channelLabel;
    const inExtra = _extraCache[id]?.channelLabel;
    return !inGuild && !inExtra;
  });

  if (!unknownIds.length) return;

  // Cap lookups per call to avoid hammering the API at startup
  const MAX_LOOKUPS_PER_CALL = 5;
  const idsToLookup = unknownIds.slice(0, MAX_LOOKUPS_PER_CALL);

  // Look up each unknown ID via openclaw CLI (handles threads, forum posts etc.)
  for (const id of idsToLookup) {
    try {
      const out = execFileSync(
        "openclaw",
        ["message", "channel", "info", "--channel", "discord", "--target", `channel:${id}`, "--json"],
        { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "ignore"] },
      );
      const jsonStart = out.indexOf("{");
      const parsed = JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out);
      const c = parsed?.payload?.channel;
      if (c?.name) {
        const meta = {
          channelId: c.id,
          channelLabel: formatDiscordChannelLabel(c.name, c.type, c.id),
          guildId: c.guild_id || null,
          parentId: c.parent_id || null,
          type: c.type,
          resolvedAt: Date.now(),
        };
        _extraCache[id] = meta;
        // Persist to cache file so it survives restarts
        _persistExtraToCache(id, meta);

        // Also cache the parent if not already known
        if (c.parent_id && !channelMetadata[c.parent_id] && !_extraCache[c.parent_id]) {
          try {
            const pout = execFileSync(
              "openclaw",
              ["message", "channel", "info", "--channel", "discord", "--target", `channel:${c.parent_id}`, "--json"],
              { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "ignore"] },
            );
            const pjsonStart = pout.indexOf("{");
            const pparsed = JSON.parse(pjsonStart >= 0 ? pout.slice(pjsonStart) : pout);
            const pc = pparsed?.payload?.channel;
            if (pc?.name) {
              const pmeta = {
                channelId: pc.id,
                channelLabel: formatDiscordChannelLabel(pc.name, pc.type, pc.id),
                guildId: pc.guild_id || null,
                parentId: pc.parent_id || null,
                type: pc.type,
                resolvedAt: Date.now(),
              };
              _extraCache[c.parent_id] = pmeta;
              _persistExtraToCache(c.parent_id, pmeta);
            }
          } catch {}
        }
      }
    } catch (e) {
      // Mark as failed so we don't retry this ID on future startups
      _lookupFailedIds.add(id);
      // Only log unexpected errors — "Missing Access" is expected for deleted channels
      if (!e.message.includes("Missing Access") && !e.message.includes("Unknown Channel")) {
        console.error("[session-labels] channel info lookup failed for", id, e.message);
      }
    }
  }
}

// ── Label builder ──────────────────────────────────────────────────────────

function titleCase(s = "") {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function humanSessionLabel(sessionKey = "", agentId = "main", channelMetadata = {}, cronJobsById = {}) {
  const allChannels = { ..._extraCache, ...channelMetadata };

  if (sessionKey.includes(":discord:channel:")) {
    const channelId = sessionKey.split(":discord:channel:")[1]?.split(":")[0];
    const meta = allChannels[channelId] || {};
    const parent = meta.parentId ? allChannels[meta.parentId] || {} : {};
    const base = meta.channelLabel || parent.channelLabel || `#${(channelId || "").slice(-8)}`;
    return agentId === "main" ? base : `${titleCase(agentId)} · ${base}`;
  }

  if (sessionKey.includes(":cron:")) {
    const jobId = sessionKey.split(":cron:")[1]?.split(":")[0];
    const jobName = cronJobsById[jobId] || null;
    if (jobName) {
      return sessionKey.includes(":run:") ? `${jobName} run` : jobName;
    }
    // No job name found — use short ID
    const shortId = (jobId || "").slice(0, 8);
    return `Cron ${shortId}`;
  }

  if (sessionKey === "agent:main:main") return "Main direct chat";
  if (sessionKey.includes(":main:main")) return `${titleCase(agentId)} direct chat`;
  if (sessionKey.includes(":subagent:")) return `Sub-agent · ${titleCase(agentId)}`;
  if (sessionKey.includes(":thread:")) return `${titleCase(agentId)} thread`;
  if (sessionKey.includes(":direct:")) return `${titleCase(agentId)} direct`;

  // Last resort: clean up the key
  return sessionKey.replace(/^agent:/, "").replace(/:/g, " › ");
}

// ── Public API ─────────────────────────────────────────────────────────────

module.exports = {
  getDiscordChannelMetadata,
  resolveUnknownChannels,
  humanSessionLabel,
  formatDiscordChannelLabel,
};
