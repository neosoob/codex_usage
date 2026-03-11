const USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const STORAGE_KEY = "codexUsageSnapshot";
const CACHE_MS = 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const OVERLAY_ID = "codex-usage-overlay-root";
const IFRAME_ID = "codex-usage-hidden-frame";
const IFRAME_TIMEOUT_MS = 15000;

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

function parseRemainingFromText(text) {
  const normalized = normalizeSpace(text);
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*%\s*剩余/i) || normalized.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? `${match[1]}%` : null;
}

function parseResetFromText(text) {
  const normalized = normalizeSpace(text);
  const match = normalized.match(/重置时间[:：]\s*(.+?)(?:\s*[•·]\s*|$)/i) || normalized.match(/reset(?:s| time)?[:：]?\s*(.+?)(?:\s*[•·]\s*|$)/i);
  return match ? normalizeSpace(match[1]) : null;
}

function parseCard(article, label) {
  if (!article) {
    return {
      label,
      remaining: null,
      resetAt: null,
      lines: []
    };
  }

  const text = normalizeSpace(article.textContent || "");
  const percentNode = Array.from(article.querySelectorAll("span, strong, div"))
    .map((node) => normalizeSpace(node.textContent || ""))
    .find((value) => /^\d+(?:\.\d+)?%$/.test(value));

  return {
    label,
    remaining: percentNode || parseRemainingFromText(text),
    resetAt: parseResetFromText(text),
    lines: splitLines(article.textContent || "")
  };
}

function findCardByTitle(doc, pattern) {
  const articles = Array.from(doc.querySelectorAll("article"));
  return articles.find((article) => {
    const titleNode = article.querySelector("p");
    const title = normalizeSpace(titleNode?.textContent || "");
    return pattern.test(title);
  }) || null;
}

function parseUsageDocument(doc) {
  const shortCard = findCardByTitle(doc, /^(?:5\s*小时使用限额|5-hour usage limit|5 hour usage limit)$/i);
  const weeklyCard = findCardByTitle(doc, /^(?:每周使用限额|weekly usage limit)$/i);

  const shortTerm = parseCard(shortCard, "5h");
  const weekly = parseCard(weeklyCard, "Weekly");

  return {
    scannedAt: new Date().toISOString(),
    sourceUrl: USAGE_URL,
    shortTerm,
    weekly,
    hints: [
      shortCard ? `DOM 命中短周期卡片：${normalizeSpace(shortCard.textContent || "")}` : "DOM 未命中短周期卡片。",
      weeklyCard ? `DOM 命中周卡片：${normalizeSpace(weeklyCard.textContent || "")}` : "DOM 未命中周卡片。"
    ]
  };
}

function isSnapshotComplete(snapshot) {
  return Boolean(snapshot?.shortTerm?.remaining || snapshot?.weekly?.remaining);
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

function getOrCreateIframe() {
  let iframe = document.getElementById(IFRAME_ID);
  if (iframe) {
    return iframe;
  }

  iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;
  iframe.src = USAGE_URL;
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  Object.assign(iframe.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    right: "0",
    bottom: "0",
    opacity: "0",
    pointerEvents: "none",
    border: "0",
    zIndex: "-1"
  });
  document.documentElement.appendChild(iframe);
  return iframe;
}

function waitForUsageDom(iframe, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observer = null;
    let timeoutId = null;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
      }
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };

    const tryResolve = () => {
      try {
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) {
          return;
        }

        const snapshot = parseUsageDocument(iframeDoc);
        if (isSnapshotComplete(snapshot)) {
          settled = true;
          cleanup();
          resolve(snapshot);
        }
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    const onLoad = () => {
      if (settled) {
        return;
      }

      tryResolve();
      if (settled) {
        return;
      }

      try {
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc?.documentElement) {
          return;
        }

        observer = new MutationObserver(() => {
          if (!settled) {
            tryResolve();
          }
        });

        observer.observe(iframeDoc.documentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    iframe.addEventListener("load", onLoad, { once: true });
    timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      cleanup();
      try {
        const partial = parseUsageDocument(iframe.contentDocument || document);
        reject(new Error(`usage 页面超时，5h=${partial.shortTerm.remaining || "--"}，Weekly=${partial.weekly.remaining || "--"}`));
      } catch (_error) {
        reject(new Error("usage 页面加载超时"));
      }
    }, timeoutMs);

    tryResolve();
  });
}

async function fetchUsageSnapshotFromIframe(forceRefresh) {
  const iframe = getOrCreateIframe();

  if (forceRefresh) {
    iframe.src = `${USAGE_URL}?_=${Date.now()}`;
  }

  const snapshot = await waitForUsageDom(iframe, IFRAME_TIMEOUT_MS);
  await saveSnapshot(snapshot);
  updateOverlay(snapshot);
  return snapshot;
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

  inflightPromise = fetchUsageSnapshotFromIframe(forceRefresh);

  try {
    return await inflightPromise;
  } finally {
    inflightPromise = null;
  }
}

function isChatPage() {
  return location.hostname.endsWith("chatgpt.com") && !location.pathname.startsWith("/codex/settings/usage");
}

function formatTimeReset(value) {
  if (!value) {
    return "--";
  }

  const normalized = normalizeSpace(value);
  const shortTimeMatch = normalized.match(/(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i);
  if (shortTimeMatch) {
    return shortTimeMatch[1].toUpperCase();
  }

  return normalized;
}

function formatDateReset(value) {
  if (!value) {
    return "--";
  }

  const normalized = normalizeSpace(value);
  const chineseDateMatch = normalized.match(/(?:\d{4}年)?(\d{1,2})月(\d{1,2})日/);
  if (chineseDateMatch) {
    const [, month, day] = chineseDateMatch;
    return `${month}月${day}日`;
  }

  const monthDayMatch = normalized.match(/([A-Z][a-z]{2}\s+\d{1,2})/);
  if (monthDayMatch) {
    return monthDayMatch[1];
  }

  return formatTimeReset(normalized);
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
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        font-family: "Segoe UI", Arial, sans-serif;
        color: #333;
      }
      #${OVERLAY_ID} .cu-shell {
        width: 180px;
        border: 1px solid #c7c7c7;
        border-radius: 8px;
        background: #ececec;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.14);
        overflow: hidden;
        transition: width 140ms ease;
      }
      #${OVERLAY_ID}:hover .cu-shell,
      #${OVERLAY_ID}:focus-within .cu-shell {
        width: 296px;
      }
      #${OVERLAY_ID} .cu-mini,
      #${OVERLAY_ID} .cu-row {
        display: grid;
        grid-template-columns: 1fr auto auto;
        align-items: center;
        column-gap: 8px;
      }
      #${OVERLAY_ID} .cu-mini {
        padding: 7px 10px;
        font-size: 12px;
        line-height: 1.1;
      }
      #${OVERLAY_ID} .cu-mini + .cu-mini {
        border-top: 1px solid #d1d1d1;
      }
      #${OVERLAY_ID} .cu-label {
        font-weight: 600;
        color: #363636;
      }
      #${OVERLAY_ID} .cu-remaining {
        font-weight: 500;
        color: #363636;
      }
      #${OVERLAY_ID} .cu-reset {
        color: #666;
        white-space: nowrap;
      }
      #${OVERLAY_ID} .cu-details {
        max-height: 0;
        overflow: hidden;
        border-top: 1px solid transparent;
        background: #f6f6f6;
        transition: max-height 140ms ease, border-color 140ms ease;
      }
      #${OVERLAY_ID}:hover .cu-details,
      #${OVERLAY_ID}:focus-within .cu-details {
        max-height: 240px;
        border-top-color: #d1d1d1;
      }
      #${OVERLAY_ID} .cu-details-inner {
        padding: 10px;
      }
      #${OVERLAY_ID} .cu-row {
        padding: 10px 0;
        font-size: 13px;
      }
      #${OVERLAY_ID} .cu-row + .cu-row {
        border-top: 1px solid #e0e0e0;
      }
      #${OVERLAY_ID} .cu-row .cu-label {
        font-size: 13px;
        font-weight: 500;
      }
      #${OVERLAY_ID} .cu-row .cu-remaining {
        font-size: 16px;
        font-weight: 700;
      }
      #${OVERLAY_ID} .cu-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 8px;
        font-size: 11px;
        color: #777;
      }
      #${OVERLAY_ID} .cu-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${OVERLAY_ID} .cu-action {
        flex: 0 0 auto;
        border: 1px solid #c6c6c6;
        border-radius: 4px;
        background: #f6f6f6;
        color: #444;
        font-size: 11px;
        line-height: 1;
        padding: 4px 6px;
        cursor: pointer;
      }
      #${OVERLAY_ID} .cu-action:hover {
        background: #fff;
      }
      #${OVERLAY_ID} .cu-action:disabled {
        opacity: 0.6;
        cursor: default;
      }
    </style>
    <div class="cu-shell" tabindex="0">
      <div class="cu-mini">
        <span class="cu-label">5h</span>
        <span class="cu-remaining" id="cu-short-mini">--</span>
        <span class="cu-reset" id="cu-short-mini-reset">--</span>
      </div>
      <div class="cu-mini">
        <span class="cu-label">Weekly</span>
        <span class="cu-remaining" id="cu-weekly-mini">--</span>
        <span class="cu-reset" id="cu-weekly-mini-reset">--</span>
      </div>
      <div class="cu-details">
        <div class="cu-details-inner">
          <div class="cu-row">
            <span class="cu-label">5 小时使用限额</span>
            <span class="cu-remaining" id="cu-short">--</span>
            <span class="cu-reset" id="cu-short-reset">--</span>
          </div>
          <div class="cu-row">
            <span class="cu-label">每周使用限额</span>
            <span class="cu-remaining" id="cu-weekly">--</span>
            <span class="cu-reset" id="cu-weekly-reset">--</span>
          </div>
          <div class="cu-foot">
            <span id="cu-foot">读取中...</span>
            <div class="cu-actions">
              <button type="button" class="cu-action" id="cu-detail">详情</button>
              <button type="button" class="cu-action" id="cu-refresh">刷新</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(root);

  const detailButton = root.querySelector("#cu-detail");
  detailButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.open(USAGE_URL, "_blank", "noopener,noreferrer");
  });

  const refreshButton = root.querySelector("#cu-refresh");
  refreshButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    refreshButton.disabled = true;
    refreshButton.textContent = "刷新中";
    try {
      await refreshOverlay(true);
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "刷新";
    }
  });

  return root;
}

function updateOverlay(snapshot, errorMessage) {
  if (!isChatPage()) {
    return;
  }

  const root = createOverlay();
  const shortMini = root.querySelector("#cu-short-mini");
  const weeklyMini = root.querySelector("#cu-weekly-mini");
  const shortMiniReset = root.querySelector("#cu-short-mini-reset");
  const weeklyMiniReset = root.querySelector("#cu-weekly-mini-reset");
  const short = root.querySelector("#cu-short");
  const weekly = root.querySelector("#cu-weekly");
  const shortReset = root.querySelector("#cu-short-reset");
  const weeklyReset = root.querySelector("#cu-weekly-reset");
  const foot = root.querySelector("#cu-foot");

  if (errorMessage) {
    shortMini.textContent = "--";
    weeklyMini.textContent = "--";
    shortMiniReset.textContent = "--";
    weeklyMiniReset.textContent = "--";
    short.textContent = "--";
    weekly.textContent = "--";
    shortReset.textContent = "--";
    weeklyReset.textContent = "--";
    foot.textContent = errorMessage;
    return;
  }

  shortMini.textContent = snapshot.shortTerm.remaining || "--";
  weeklyMini.textContent = snapshot.weekly.remaining || "--";
  shortMiniReset.textContent = formatTimeReset(snapshot.shortTerm.resetAt);
  weeklyMiniReset.textContent = formatDateReset(snapshot.weekly.resetAt);
  short.textContent = snapshot.shortTerm.remaining || "--";
  weekly.textContent = snapshot.weekly.remaining || "--";
  shortReset.textContent = snapshot.shortTerm.resetAt || "--";
  weeklyReset.textContent = snapshot.weekly.resetAt || "--";
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
