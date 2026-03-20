const LABEL_PATTERNS = {
  session: ["session", "5h", "5-hour", "5 hour"],
  weekly: ["weekly all models", "all models", "week", "weekly"],
  sonnet: ["weekly sonnet", "sonnet"],
};

function normalizeText(input) {
  return String(input || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWindowBlock(text, labels) {
  const lower = text.toLowerCase();
  for (const label of labels) {
    const idx = lower.indexOf(label.toLowerCase());
    if (idx >= 0) {
      return text.slice(idx, Math.min(text.length, idx + 220));
    }
  }
  return "";
}

function extractPct(block) {
  if (!block) return null;

  const usedMatch = block.match(/(\d{1,3})\s*%\s*(?:used|usage|consumed)/i);
  if (usedMatch) return clampPct(Number(usedMatch[1]));

  const leftMatch = block.match(/(\d{1,3})\s*%\s*(?:left|remaining)/i);
  if (leftMatch) return clampPct(100 - Number(leftMatch[1]));

  const generic = [...block.matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1]));
  if (generic.length === 1) return clampPct(generic[0]);
  if (generic.length >= 2) {
    const maybeUsed = generic.find((n) => n <= 100);
    return clampPct(maybeUsed);
  }

  return null;
}

function extractReset(block) {
  if (!block) return null;

  const specificPatterns = [
    /resets?\s+in\s+(\d+\s*(?:m|h|d|min|mins|hour|hours|day|days|week|weeks))/i,
    /resets?\s+(?:at|on)\s+([^.,;|]+?(?:am|pm))/i,
    /resets?\s+((?:mon|tue|wed|thu|fri|sat|sun)[^.,;|]*?(?:am|pm))/i,
    /resets?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^.,;|]*?(?:am|pm)?)/i,
  ];

  for (const pattern of specificPatterns) {
    const match = block.match(pattern);
    if (match) return match[1].trim();
  }

  const relativeMatch = block.match(/\b(?:in\s+)?(\d+\s*(?:m|h|d|min|mins|hour|hours|day|days|week|weeks))\b/i);
  return relativeMatch ? relativeMatch[1].trim() : null;
}

function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseWindow(text, labels) {
  const block = extractWindowBlock(text, labels);
  const usedPct = extractPct(block);
  const reset = extractReset(block);
  return {
    found: Boolean(block),
    block,
    usedPct,
    remainingPct: usedPct == null ? null : 100 - usedPct,
    reset,
  };
}

function parseAnthropicUsageHtml(html, meta = {}) {
  const text = normalizeText(html);
  const session = parseWindow(text, LABEL_PATTERNS.session);
  const weekly = parseWindow(text, LABEL_PATTERNS.weekly);
  const sonnet = parseWindow(text, LABEL_PATTERNS.sonnet);

  return {
    timestamp: new Date().toISOString(),
    source: "scraped",
    provider: "anthropic",
    url: meta.url || null,
    claude: {
      session: {
        usedPct: session.usedPct,
        remainingPct: session.remainingPct,
        resetsIn: session.reset,
      },
      weekly: {
        usedPct: weekly.usedPct,
        remainingPct: weekly.remainingPct,
        resets: weekly.reset,
      },
      sonnet: {
        usedPct: sonnet.usedPct,
        remainingPct: sonnet.remainingPct,
        resets: sonnet.reset,
      },
      lastSynced: new Date().toISOString(),
    },
    scrape: {
      ok: [session, weekly, sonnet].some((item) => item.usedPct != null || item.reset),
      extractedAt: new Date().toISOString(),
      labelsFound: {
        session: session.found,
        weekly: weekly.found,
        sonnet: sonnet.found,
      },
    },
    debug: {
      snippets: {
        session: session.block || null,
        weekly: weekly.block || null,
        sonnet: sonnet.block || null,
      },
    },
  };
}

module.exports = {
  parseAnthropicUsageHtml,
  normalizeText,
};
