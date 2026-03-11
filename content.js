const USAGE_KEYWORDS = [
  "codex",
  "usage",
  "remaining",
  "limit",
  "used",
  "reset",
  "resets",
  "quota",
  "credits",
  "messages",
  "requests",
  "runs"
];

function normalizeSpace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function collectRelevantLines(text) {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean);

  return lines.filter((line) =>
    USAGE_KEYWORDS.some((keyword) => line.toLowerCase().includes(keyword))
  );
}

function extractNumber(text) {
  const match = text.match(/\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(",", "") : null;
}

function buildSnapshot() {
  const pageText = normalizeSpace(document.body?.innerText || "");
  const relevantLines = collectRelevantLines(document.body?.innerText || "").slice(0, 20);

  const snapshot = {
    title: document.title || "",
    url: location.href,
    scannedAt: new Date().toISOString(),
    remaining: null,
    used: null,
    limit: null,
    resetAt: null,
    hints: [],
    relevantLines
  };

  const remainingPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:messages|requests|runs|credits)?\s*remaining/i,
    /remaining\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/i
  ];

  for (const pattern of remainingPatterns) {
    const match = pageText.match(pattern);
    if (match) {
      snapshot.remaining = match[1].replace(",", "");
      snapshot.hints.push(`Matched remaining: ${match[0]}`);
      break;
    }
  }

  const usedLimitPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:\/|of)\s*(\d+(?:[.,]\d+)?)/i,
    /used\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*(?:\/|of)?\s*(\d+(?:[.,]\d+)?)?/i
  ];

  for (const pattern of usedLimitPatterns) {
    const match = pageText.match(pattern);
    if (match) {
      snapshot.used = match[1]?.replace(",", "") || null;
      snapshot.limit = match[2]?.replace(",", "") || null;
      snapshot.hints.push(`Matched usage pair: ${match[0]}`);
      break;
    }
  }

  const resetPatterns = [
    /(resets?\s*(?:at|on|in)?\s*[:\-]?\s*[^.\n]+)/i,
    /(next reset\s*[:\-]?\s*[^.\n]+)/i
  ];

  for (const pattern of resetPatterns) {
    const match = pageText.match(pattern);
    if (match) {
      snapshot.resetAt = normalizeSpace(match[1]);
      snapshot.hints.push(`Matched reset: ${snapshot.resetAt}`);
      break;
    }
  }

  if (!snapshot.remaining && snapshot.used && snapshot.limit) {
    const used = Number(snapshot.used);
    const limit = Number(snapshot.limit);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit >= used) {
      snapshot.remaining = String(limit - used);
      snapshot.hints.push("Calculated remaining from used/limit.");
    }
  }

  if (!snapshot.remaining) {
    const candidate = relevantLines.find((line) => /remaining/i.test(line));
    if (candidate) {
      snapshot.remaining = extractNumber(candidate);
      if (snapshot.remaining) {
        snapshot.hints.push(`Fallback remaining line: ${candidate}`);
      }
    }
  }

  return snapshot;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CODEX_USAGE") {
    sendResponse(buildSnapshot());
  }
});
