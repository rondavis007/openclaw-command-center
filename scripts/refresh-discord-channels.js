#!/usr/bin/env node
/**
 * Script provenance
 * Created/maintained by: Clawbaby (OpenClaw main agent)
 * Why: Refresh Discord channel cache used by Command Center + session label cleanup.
 * Added/updated: 2026-04-04
 *
 * This version avoids stale old CLI assumptions and uses the current OpenClaw CLI.
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.openclaw');
const CACHE_PATH = path.join(STATE_DIR, 'state', 'discord-channel-cache.json');
const FAILED_IDS_PATH = path.join(STATE_DIR, 'state', 'discord-channel-cache.failed-ids.json');
const CONFIG_PATH = path.join(STATE_DIR, 'openclaw.json');
const ENV_PATH = path.join(STATE_DIR, '.env');

let cachedDotEnv = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function deleteFileIfExists(file) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

function parseDotEnvValue(raw) {
  const value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotEnvMap() {
  if (cachedDotEnv) return cachedDotEnv;
  const map = new Map();
  if (!fs.existsSync(ENV_PATH)) {
    cachedDotEnv = map;
    return map;
  }
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = parseDotEnvValue(trimmed.slice(eqIndex + 1));
    map.set(key, value);
  }
  cachedDotEnv = map;
  return map;
}

function getEnvValue(name) {
  const direct = process.env[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const dotEnv = loadDotEnvMap();
  const fallback = dotEnv.get(name);
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return null;
}

function resolveToken(rawValue) {
  if (typeof rawValue === 'string' && rawValue.trim()) {
    const value = rawValue.trim();
    const bracedEnvMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (bracedEnvMatch) {
      const envName = bracedEnvMatch[1];
      const envValue = getEnvValue(envName);
      if (envValue) return envValue;
      throw new Error(`Missing env var for Discord token placeholder: ${envName}`);
    }

    const bareEnvMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (bareEnvMatch) {
      const envName = bareEnvMatch[1];
      const envValue = getEnvValue(envName);
      if (envValue) return envValue;
      throw new Error(`Missing env var for Discord token placeholder: ${envName}`);
    }

    return value;
  }
  if (rawValue && typeof rawValue === 'object' && rawValue.source === 'env' && typeof rawValue.id === 'string') {
    const value = getEnvValue(rawValue.id);
    if (value) return value;
    throw new Error(`Missing env var for Discord token ref: ${rawValue.id}`);
  }
  return null;
}

function normalizeChannelEntries(items, guildId) {
  const out = {};
  for (const item of items) {
    const id = String(item.id || item.channelId || '').trim();
    if (!id) continue;
    const name = item.name || item.channelName || item.label || item.topic || id;
    const parentId = item.parentId || item.parent_id || null;
    const type = item.type ?? item.channelType ?? null;
    out[id] = {
      guildId,
      channelLabel: String(name).startsWith('#') ? String(name) : `#${String(name)}`,
      parentId: parentId ? String(parentId) : null,
      type,
    };
  }
  return out;
}

function buildGuildFetchPlans(cfg) {
  const discord = cfg?.channels?.discord || {};
  const topLevelGuildIds = Object.keys(discord.guilds || {});
  const topLevelToken = resolveToken(discord.token);
  const plans = new Map();

  function ensurePlan(guildId) {
    const id = String(guildId || '').trim();
    if (!id) return null;
    if (!plans.has(id)) {
      plans.set(id, { guildId: id, candidates: [] });
    }
    return plans.get(id);
  }

  for (const guildId of topLevelGuildIds) {
    ensurePlan(guildId);
  }

  if (topLevelToken) {
    for (const guildId of topLevelGuildIds) {
      const plan = ensurePlan(guildId);
      if (plan) {
        plan.candidates.push({ accountId: 'top-level', token: topLevelToken });
      }
    }
  }

  const accounts = discord.accounts || {};
  for (const [accountId, accountCfg] of Object.entries(accounts)) {
    if (accountCfg?.enabled === false) continue;
    const token = resolveToken(accountCfg?.token);
    if (!token) continue;
    const accountGuildIds = Object.keys(accountCfg?.guilds || {});
    for (const guildId of accountGuildIds) {
      const plan = ensurePlan(guildId);
      if (!plan) continue;
      plan.candidates.push({ accountId, token });
    }
  }

  for (const plan of plans.values()) {
    const seen = new Set();
    plan.candidates = plan.candidates.filter((candidate) => {
      const key = `${candidate.accountId}:${candidate.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return Array.from(plans.values()).filter((plan) => plan.candidates.length > 0);
}

function fetchDiscordJson(urlPath, botToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'GET',
        host: 'discord.com',
        path: `/api/v10${urlPath}`,
        headers: {
          Authorization: `Bot ${botToken}`,
          'User-Agent': 'openclaw-discord-channel-cache/1.0',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = body;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const reason = typeof parsed === 'object' && parsed?.message
            ? parsed.message
            : typeof parsed === 'string'
              ? parsed.slice(0, 240)
              : `HTTP ${res.statusCode}`;
          reject(new Error(`Discord API ${res.statusCode} for ${urlPath}: ${reason}`));
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function listGuildChannels(guildId, token) {
  const payload = await fetchDiscordJson(`/guilds/${guildId}/channels`, token);
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected guild channel payload shape for guild ${guildId}`);
  }
  return payload;
}

async function getChannelInfo(channelId, token) {
  const payload = await fetchDiscordJson(`/channels/${channelId}`, token);
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Unexpected channel-info payload shape for channel ${channelId}`);
  }
  return payload;
}

function summarizeError(err) {
  return String(err?.message || err || 'unknown error');
}

async function fetchGuildViaCandidates(plan) {
  const attempts = [];
  for (const candidate of plan.candidates) {
    try {
      const items = await listGuildChannels(plan.guildId, candidate.token);
      return {
        ok: true,
        guildId: plan.guildId,
        accountId: candidate.accountId,
        items,
        attempts,
      };
    } catch (err) {
      attempts.push({ accountId: candidate.accountId, error: summarizeError(err) });
    }
  }
  return {
    ok: false,
    guildId: plan.guildId,
    attempts,
  };
}

async function refreshFailedGuildChannelsFromKnownIds(previousChannels, failedGuildIds, guildPlans) {
  const refreshed = {};
  const staleFallbackIds = [];
  const attempts = [];

  for (const [channelId, previousInfo] of Object.entries(previousChannels || {})) {
    const guildId = String(previousInfo?.guildId || '');
    if (!failedGuildIds.has(guildId)) continue;

    const plan = guildPlans.get(guildId);
    const candidates = plan?.candidates || [];
    let liveEntry = null;
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const info = await getChannelInfo(channelId, candidate.token);
        const normalized = normalizeChannelEntries([info], guildId);
        if (normalized[channelId]) {
          liveEntry = normalized[channelId];
          break;
        }
        throw new Error('channel-info returned no usable channel object');
      } catch (err) {
        lastError = summarizeError(err);
      }
    }

    if (liveEntry) {
      refreshed[channelId] = liveEntry;
      continue;
    }

    refreshed[channelId] = previousInfo;
    staleFallbackIds.push(channelId);
    attempts.push({
      channelId,
      guildId,
      error: lastError || 'No valid token candidates for failed guild',
    });
  }

  return { refreshed, staleFallbackIds, attempts };
}

function main() {
  return (async () => {
    const cfg = readJson(CONFIG_PATH);
    const plans = buildGuildFetchPlans(cfg);
    if (!plans.length) {
      throw new Error('No Discord guild/token fetch plans could be resolved from config.');
    }

    const previous = fs.existsSync(CACHE_PATH) ? readJson(CACHE_PATH) : {};
    const previousChannels = previous.channels || {};
    const freshChannels = {};
    const failures = [];
    const guildPlansById = new Map(plans.map((plan) => [plan.guildId, plan]));
    let successGuildCount = 0;

    for (const plan of plans) {
      const result = await fetchGuildViaCandidates(plan);
      if (result.ok) {
        const normalized = normalizeChannelEntries(result.items, plan.guildId);
        Object.assign(freshChannels, normalized);
        successGuildCount += 1;
        console.log(
          `[ok] guild ${plan.guildId}: fetched ${Object.keys(normalized).length} channels (account: ${result.accountId})`,
        );
      } else {
        failures.push({
          guildId: plan.guildId,
          error: result.attempts.map((a) => `${a.accountId}: ${a.error}`).join(' | ') || 'Unknown fetch error',
          attempts: result.attempts,
        });
        console.log(`[fail] guild ${plan.guildId}: ${failures[failures.length - 1].error}`);
      }
    }

    if (successGuildCount === 0) {
      console.error('Preflight failed: no guild channel list succeeded. Cache was NOT updated.');
      process.exitCode = 2;
      return;
    }

    const failedGuildIds = new Set(failures.map((f) => f.guildId));
    const {
      refreshed: fallbackChannels,
      staleFallbackIds,
      attempts: fallbackAttempts,
    } = await refreshFailedGuildChannelsFromKnownIds(previousChannels, failedGuildIds, guildPlansById);

    const channels = {
      ...freshChannels,
      ...fallbackChannels,
    };

    const partial = failures.length > 0;
    const stale = partial;

    const cache = {
      fetchedAt: Date.now(),
      status: partial ? 'partial' : 'ok',
      partial,
      stale,
      summary: {
        guildsConfigured: plans.length,
        guildsSucceeded: successGuildCount,
        guildsFailed: failures.length,
        channelsFresh: Object.keys(freshChannels).length,
        channelsFallback: Object.keys(fallbackChannels).length,
        staleFallbackIds: staleFallbackIds.length,
      },
      failures,
      fallback: {
        mode: partial ? 'channel-info-then-stale-cache' : 'none',
        attempts: fallbackAttempts,
      },
      channels,
    };

    writeJson(CACHE_PATH, cache);
    if (staleFallbackIds.length) {
      writeJson(FAILED_IDS_PATH, staleFallbackIds.sort());
    } else {
      deleteFileIfExists(FAILED_IDS_PATH);
    }

    console.log('---');
    console.log(`Wrote ${Object.keys(channels).length} cached Discord channel entries to ${CACHE_PATH}`);
    if (partial) {
      console.log(`Partial refresh: ${failures.length} guild(s) failed, cache marked stale.`);
      process.exitCode = 1;
    } else {
      console.log('Refresh status: healthy');
    }
  })().catch((err) => {
    console.error(`[fatal] ${summarizeError(err)}`);
    process.exitCode = 2;
  });
}

main();
