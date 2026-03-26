/**
 * Created/maintained by Clawbaby.
 * Purpose: Parse OpenAI Codex usage page snapshot into normalized JSON.
 * Added: 2026-03-21.
 */

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
      return text.slice(idx, Math.min(text.length, idx + 300));
    }
  }
  return "";
}

function clampPct(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Returns { usedPct, remainingPct } — handles both "X% used" and "X% remaining" formats.
 * Codex usage page reports "X% remaining", Claude reports "X% used".
 */
function extractPcts(block) {
  if (!block) return { usedPct: null, remainingPct: null };

  const usedMatch = block.match(/(\d{1,3})\s*%\s*(?:used|usage|consumed)/i);
  if (usedMatch) {
    const used = clampPct(Number(usedMatch[1]));
    return { usedPct: used, remainingPct: 100 - used };
  }

  const leftMatch = block.match(/(\d{1,3})\s*%\s*(?:remaining|left)/i);
  if (leftMatch) {
    const remaining = clampPct(Number(leftMatch[1]));
    return { usedPct: 100 - remaining, remainingPct: remaining };
  }

  // fallback: single bare percentage — assume it's "remaining" for Codex pages
  const generic = [...block.matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1]));
  if (generic.length >= 1) {
    const remaining = clampPct(generic[0]);
    return { usedPct: 100 - remaining, remainingPct: remaining };
  }

  return { usedPct: null, remainingPct: null };
}

function extractReset(block) {
  if (!block) return null;

  const patterns = [
    // "Resets Apr 1, 2026 2:22 PM" — full date + time (most specific first)
    /resets?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm))/i,
    // "Resets Apr 1, 2026" — date without time
    /resets?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s+\d{4})/i,
    // "Resets in 5 hours"
    /resets?\s+in\s+(\d+\s*(?:m|h|d|min|mins|hour|hours|day|days|week|weeks))/i,
    // "Resets at/on <time>"
    /resets?\s+(?:at|on)\s+([^.,;|]+?(?:am|pm))/i,
    // "Resets Monday 2:22 PM"
    /resets?\s+((?:mon|tue|wed|thu|fri|sat|sun)[^.,;|]*?(?:am|pm))/i,
    // Fallback: month name only
    /resets?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^.,;|\s][^.,;|]*)/i,
  ];

  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match) return match[1].trim();
  }

  const relativeMatch = block.match(/\b(?:in\s+)?(\d+\s*(?:m|h|d|min|mins|hour|hours|day|days|week|weeks))\b/i);
  return relativeMatch ? relativeMatch[1].trim() : null;
}

function parseWindow(text, labels) {
  const block = extractWindowBlock(text, labels);
  const { usedPct, remainingPct } = extractPcts(block);
  const reset = extractReset(block);
  return {
    found: Boolean(block),
    block,
    usedPct,
    remainingPct,
    reset,
  };
}

function parseCodexUsageHtml(html, meta = {}) {
  const text = normalizeText(html);

  // Codex usage page labels
  const hourly = parseWindow(text, ["5 hour usage limit", "5-hour usage limit", "5 hour limit", "5-hour limit", "5h limit"]);
  const weekly = parseWindow(text, ["weekly usage limit", "weekly limit"]);
  const codeReview = parseWindow(text, ["code review"]);

  // Credits remaining — look for a number near "credits remaining"
  let creditsRemaining = null;
  const creditsBlock = extractWindowBlock(text, ["credits remaining"]);
  if (creditsBlock) {
    const match = creditsBlock.match(/credits remaining\s*(\d[\d,]*)/i) ||
                  creditsBlock.match(/(\d[\d,]*)\s*credits remaining/i);
    if (match) creditsRemaining = parseInt(match[1].replace(/,/g, ''), 10);
  }

  // Weekly reset date — look for the explicit reset date near the weekly block
  let weeklyResets = weekly.reset;
  if (!weeklyResets) {
    const resetBlock = extractWindowBlock(text, ["resets mar", "resets apr", "resets may", "resets jun", "resets jul", "resets aug"]);
    if (resetBlock) {
      const match = resetBlock.match(/resets\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^.,;|]{0,40})/i);
      if (match) weeklyResets = match[1].trim();
    }
  }

  return {
    timestamp: new Date().toISOString(),
    source: "scraped",
    provider: "openai-codex",
    url: meta.url || null,
    codex: {
      hourly: {
        usedPct: hourly.usedPct,
        remainingPct: hourly.remainingPct,
        resetsIn: hourly.reset,
      },
      weekly: {
        usedPct: weekly.usedPct,
        remainingPct: weekly.remainingPct,
        resets: weeklyResets,
        resetsAt: weeklyResets || null,
      },
      codeReview: {
        usedPct: codeReview.usedPct,
        remainingPct: codeReview.remainingPct,
        resets: codeReview.reset,
      },
      credits: creditsRemaining,
      lastSynced: new Date().toISOString(),
    },
    scrape: {
      ok: [hourly, weekly].some((item) => item.usedPct != null || item.reset),
      extractedAt: new Date().toISOString(),
      labelsFound: {
        hourly: hourly.found,
        weekly: weekly.found,
        codeReview: codeReview.found,
        credits: creditsRemaining !== null,
      },
    },
    debug: {
      snippets: {
        hourly: hourly.block || null,
        weekly: weekly.block || null,
        codeReview: codeReview.block || null,
        credits: creditsBlock || null,
      },
    },
  };
}

module.exports = {
  parseCodexUsageHtml,
  normalizeText,
};
