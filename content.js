const USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const STORAGE_KEY = "codexUsageSnapshot";
const CACHE_MS = 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const OVERLAY_ID = "codex-usage-overlay-root";

let snapshotCache = null;
let inflightPromise = null;
let overlayInitialized = false;

function normalizeSpace(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function splitLines(value) {
  return (value || "")
    .split(/\n+/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean);
}

function extractSection(lines, titlePattern, stopPatterns) {
  const startIndex = lines.findIndex((line) => titlePattern.test(line));
  if (startIndex === -1) {
    return null;
  }

  const section = [lines[startIndex]];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (stopPatterns.some((pattern) => pattern.test(line))) {
      break;
    }
    section.push(line);
    if (section.length >= 6) {
      break;
    }
  }

  return section;
}

function parseRemaining(sectionLines) {
  const joined = sectionLines.join(" ");
  const percentMatch = joined.match(/(\d+(?:\.\d+)?)\s*%\s*剩余/i) || joined.match(/remaining\s*(\d+(?:\.\d+)?)\s*%/i) || joined.match(/(\d+(?:\.\d+)?)\s*%/);
  return percentMatch ? `${percentMatch[1]}%` : null;
}

function parseReset(sectionLines) {
  for (const line of sectionLines) {
    const match = line.match(/重置时间[:：]\s*(.+)/i) || line.match(/reset(?:s| time)?[:：]?\s*(.+)/i);
    if (match) {
      return normalizeSpace(match[1]);
    }
  }
  return null;
}

function makeLimit(label, sectionLines) {
  if (!sectionLines) {
    return {
      label,
      remaining: null,
      resetAt: null,
      lines: []
    };
  }

  return {
    label,
    remaining: parseRemaining(sectionLines),
    resetAt: parseReset(sectionLines),
    lines: sectionLines
  };
}

function parseUsageDocument(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const bodyText = doc.body?.innerText || doc.documentElement?.textContent || "";
  const lines = splitLines(bodyText);

  const shortSection = extractSection(
    lines,
    /(?:^|\s)(?:5\s*小时使用限额|5-hour usage limit|5 hour usage limit)(?:$|\s)/i,
    [/(?:^|\s)(?:每周使用限额|weekly usage limit)(?:$|\s)/i]
  );

  const weeklySection = extractSection(
    lines,
    /(?:^|\s)(?:每周使用限额|weekly usage limit)(?:$|\s)/i,
    []
  );

  const shortTerm = makeLimit("5 小时使用限额", shortSection);
  const weekly = makeLimit("每周使用限额", weeklySection);

  return {
    scannedAt: new Date().toISOString(),
    sourceUrl: USAGE_URL,
    shortTerm,
    weekly,
    hints: [
      shortSection ? `命中短周期区块：${shortSection.join(" | ")}` : "未命中短周期区块。",
      weeklySection ? `命中周区块：${weeklySection.join(" | ")}` : "未命中周区块。"
    ]
  };
}

async function saveSnapshot(snapshot) {
  snapshotCache = snapshot;
  await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
}

async function loadSnapshot() {
  if (snapshotCache) {
    return snapshotCache;
  }

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  snapshotCache = stored?.[STORAGE_KEY] || null;
  return snapshotCache;
}

async function fetchUsageSnapshot(forceRefresh = false) {
  const cached = await loadSnapshot();
  const cacheAge = cached ? Date.now() - new Date(cached.scannedAt).getTime() : Infinity;

  if (!forceRefresh && cached && cacheAge < CACHE_MS) {
    return cached;
  }

  if (inflightPromise) {
    return inflightPromise;
  }

  inflightPromise = (async () => {
    const response = await fetch(USAGE_URL, {
      credentials: "include",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const snapshot = parseUsageDocument(html);
    await saveSnapshot(snapshot);
    updateOverlay(snapshot);
    return snapshot;
  })();

  try {
    return await inflightPromise;
  } finally {
    inflightPromise = null;
  }
}

function isChatPage() {
  return location.hostname.endsWith("chatgpt.com") && !location.pathname.startsWith("/codex/settings/usage");
}

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) {
    return document.getElementById(OVERLAY_ID);
  }

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.innerHTML = `
    <style>
      #${OVERLAY_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        font-family: "Segoe UI", "PingFang SC", sans-serif;
        color: #1d1a16;
      }
      #${OVERLAY_ID} .cu-shell {
        width: 164px;
        border: 1px solid rgba(152, 102, 72, 0.35);
        border-radius: 16px;
        background: linear-gradient(180deg, rgba(255, 248, 240, 0.98), rgba(245, 231, 220, 0.95));
        box-shadow: 0 12px 35px rgba(76, 44, 22, 0.18);
        overflow: hidden;
        transition: width 180ms ease, transform 180ms ease;
        backdrop-filter: blur(10px);
      }
      #${OVERLAY_ID}:hover .cu-shell,
      #${OVERLAY_ID}:focus-within .cu-shell {
        width: 296px;
        transform: translateY(-2px);
      }
      #${OVERLAY_ID} .cu-summary {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
      }
      #${OVERLAY_ID} .cu-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #a33f1f;
        box-shadow: 0 0 0 4px rgba(163, 63, 31, 0.14);
        flex: 0 0 auto;
      }
      #${OVERLAY_ID} .cu-title {
        font-size: 12px;
        color: #6e655a;
      }
      #${OVERLAY_ID} .cu-values {
        margin-left: auto;
        text-align: right;
        font-size: 12px;
        font-weight: 700;
      }
      #${OVERLAY_ID} .cu-details {
        max-height: 0;
        overflow: hidden;
        padding: 0 12px;
        transition: max-height 180ms ease, padding 180ms ease;
        border-top: 1px solid transparent;
      }
      #${OVERLAY_ID}:hover .cu-details,
      #${OVERLAY_ID}:focus-within .cu-details {
        max-height: 220px;
        padding: 12px;
        border-top-color: rgba(152, 102, 72, 0.2);
      }
      #${OVERLAY_ID} .cu-row + .cu-row {
        margin-top: 10px;
      }
      #${OVERLAY_ID} .cu-label {
        font-size: 12px;
        color: #6e655a;
      }
      #${OVERLAY_ID} .cu-main {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-top: 2px;
      }
      #${OVERLAY_ID} .cu-main strong {
        font-size: 22px;
        color: #a33f1f;
      }
      #${OVERLAY_ID} .cu-reset {
        margin-top: 2px;
        font-size: 12px;
        color: #6e655a;
      }
      #${OVERLAY_ID} .cu-foot {
        margin-top: 10px;
        font-size: 11px;
        color: #7f7569;
      }
    </style>
    <div class="cu-shell" tabindex="0">
      <div class="cu-summary">
        <span class="cu-dot"></span>
        <div>
          <div class="cu-title">Codex 余额</div>
          <div class="cu-title" id="cu-status">读取中...</div>
        </div>
        <div class="cu-values">
          <div id="cu-short-mini">5h --</div>
          <div id="cu-weekly-mini">周 --</div>
        </div>
      </div>
      <div class="cu-details">
        <div class="cu-row">
          <div class="cu-label">5 小时使用限额</div>
          <div class="cu-main"><strong id="cu-short">--</strong><span id="cu-short-reset">重置时间：--</span></div>
        </div>
        <div class="cu-row">
          <div class="cu-label">每周使用限额</div>
          <div class="cu-main"><strong id="cu-weekly">--</strong><span id="cu-weekly-reset">重置时间：--</span></div>
        </div>
        <div class="cu-foot" id="cu-foot">悬停查看详情</div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(root);
  return root;
}

function updateOverlay(snapshot, errorMessage) {
  if (!isChatPage()) {
    return;
  }

  const root = createOverlay();
  const shortMini = root.querySelector("#cu-short-mini");
  const weeklyMini = root.querySelector("#cu-weekly-mini");
  const short = root.querySelector("#cu-short");
  const weekly = root.querySelector("#cu-weekly");
  const shortReset = root.querySelector("#cu-short-reset");
  const weeklyReset = root.querySelector("#cu-weekly-reset");
  const foot = root.querySelector("#cu-foot");
  const status = root.querySelector("#cu-status");

  if (errorMessage) {
    status.textContent = errorMessage;
    foot.textContent = "无法从 usage 页面读取余额。";
    return;
  }

  status.textContent = "来自 usage 页面";
  shortMini.textContent = `5h ${snapshot.shortTerm.remaining || "--"}`;
  weeklyMini.textContent = `周 ${snapshot.weekly.remaining || "--"}`;
  short.textContent = snapshot.shortTerm.remaining || "--";
  weekly.textContent = snapshot.weekly.remaining || "--";
  shortReset.textContent = `重置时间：${snapshot.shortTerm.resetAt || "--"}`;
  weeklyReset.textContent = `重置时间：${snapshot.weekly.resetAt || "--"}`;
  foot.textContent = `更新于 ${new Date(snapshot.scannedAt).toLocaleString("zh-CN")}`;
}

async function refreshOverlay(forceRefresh = false) {
  if (!isChatPage()) {
    return;
  }

  try {
    const snapshot = await fetchUsageSnapshot(forceRefresh);
    updateOverlay(snapshot);
  } catch (error) {
    updateOverlay(null, `读取失败：${error.message}`);
  }
}

function initOverlay() {
  if (!isChatPage() || overlayInitialized) {
    return;
  }

  overlayInitialized = true;
  createOverlay();
  refreshOverlay(false);
  window.setInterval(() => {
    refreshOverlay(true);
  }, REFRESH_MS);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CODEX_USAGE") {
    fetchUsageSnapshot(Boolean(message.forceRefresh))
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initOverlay, { once: true });
} else {
  initOverlay();
}
