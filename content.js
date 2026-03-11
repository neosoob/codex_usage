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
let iframePromise = null;

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

  const shortTerm = parseCard(shortCard, "5 小时使用限额");
  const weekly = parseCard(weeklyCard, "每周使用限额");

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
        reject(new Error(`usage 页面超时，短周期=${partial.shortTerm.remaining || "--"}，每周=${partial.weekly.remaining || "--"}`));
      } catch (error) {
        reject(new Error("usage 页面加载超时"));
      }
    }, timeoutMs);

    tryResolve();
  });
}

async function fetchUsageSnapshotFromIframe(forceRefresh) {
  const iframe = getOrCreateIframe();

  if (forceRefresh) {
    iframe.src = `${USAGE_URL}${USAGE_URL.includes("?") ? "&" : "?"}_=${Date.now()}`;
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

  inflightPromise = (async () => {
    try {
      return await fetchUsageSnapshotFromIframe(forceRefresh);
    } finally {
      iframePromise = null;
    }
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

  status.textContent = "来自登录态 usage 页面";
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
