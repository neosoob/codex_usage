const USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const STORAGE_KEY = "codexUsageSnapshot";
const CACHE_MS = 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;
const BATTERY_REFRESH_MS = 60 * 1000;
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

function formatDetailReset(value) {
  if (!value) {
    return "--";
  }

  const normalized = normalizeSpace(value);
  const match = normalized.match(/(?:\d{4}年)?(\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)/);
  if (match) {
    return match[1];
  }

  return normalized.replace(/^\d{4}年/, "");
}

function formatBatteryTimestamp(value) {
  if (!value) {
    return "--";
  }

  const normalized = normalizeSpace(value);
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}:\d{2})/);
  if (match) {
    const [, _year, month, day, time] = match;
    return `${Number(month)}/${Number(day)} ${time}`;
  }

  return normalized;
}

function updateBatteryBadge(data, errorMessage) {
  if (!isChatPage()) {
    return;
  }

  const root = createOverlay();
  const badge = root.querySelector("#cu-battery-badge");
  if (!badge) {
    return;
  }

  if (errorMessage) {
    badge.textContent = errorMessage;
    badge.title = errorMessage;
    return;
  }

  if (!data?.ok || !data.has_data) {
    badge.textContent = "无电量";
    badge.title = "电量接口暂无可用记录";
    return;
  }

  const battery = Number.isFinite(Number(data.battery)) ? `${Number(data.battery)}%` : "--";
  const timestamp = formatBatteryTimestamp(data.timestamp);
  badge.textContent = `${timestamp} ${battery}`;
  badge.title = [
    `电量：${battery}`,
    `时间：${data.timestamp || "--"}`,
    data.location ? `位置：${data.location}` : null,
    Number.isFinite(Number(data.age_seconds)) ? `距今：${Math.round(Number(data.age_seconds) / 60)} 分钟` : null
  ].filter(Boolean).join("\n");
}

async function refreshBatteryBadge() {
  if (!isChatPage()) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LATEST_BATTERY" });
    if (!response?.ok) {
      throw new Error(response?.error || "电量接口无响应");
    }
    updateBatteryBadge(response.data);
  } catch (error) {
    updateBatteryBadge(null, `电量失败：${error.message}`);
  }
}

function syncToggleIcon(root, expanded) {
  const toggleButton = root.querySelector("#cu-toggle");
  const toggleExpand = root.querySelector("#cu-toggle-expand");
  const toggleCollapse = root.querySelector("#cu-toggle-collapse");
  if (!toggleButton || !toggleExpand || !toggleCollapse) {
    return;
  }

  toggleButton.setAttribute("aria-expanded", String(expanded));
  toggleButton.setAttribute("aria-label", expanded ? "收起详情" : "展开详情");
  toggleExpand.style.display = expanded ? "none" : "block";
  toggleCollapse.style.display = expanded ? "block" : "none";
}

function collapseToThumbnail(root) {
  root.classList.remove("is-expanded");
  syncToggleIcon(root, false);
}

function restoreOverlay(root) {
  root.classList.remove("is-hidden");
  collapseToThumbnail(root);
}

function minimizeOverlay(root) {
  collapseToThumbnail(root);
  root.classList.add("is-hidden");
}

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) {
    return document.getElementById(OVERLAY_ID);
  }

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.innerHTML = `
    <style>
      @keyframes cu-refresh-spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
      #${OVERLAY_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        font-family: "Segoe UI", Arial, sans-serif;
        color: #333;
        transform-origin: bottom right;
        width: 296px;
        height: 240px;
        pointer-events: none;
      }
      #${OVERLAY_ID} .cu-restore {
        position: absolute;
        right: 0;
        bottom: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border: 1px solid #d8d8d8;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.10);
        color: #767676;
        cursor: pointer;
        backdrop-filter: blur(6px);
        opacity: 0;
        pointer-events: none;
      }
      #${OVERLAY_ID} .cu-restore:hover {
        box-shadow: 0 12px 22px rgba(0, 0, 0, 0.12);
        background: #ffffff;
        border-color: #cfcfcf;
        color: #4f4f4f;
      }
      #${OVERLAY_ID}.is-hidden .cu-restore {
        opacity: 1;
        pointer-events: auto;
      }
      #${OVERLAY_ID} .cu-restore svg {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
      }
      #${OVERLAY_ID} .cu-shell {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 180px;
        border: 1px solid #c7c7c7;
        border-radius: 8px;
        background: #ececec;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.14);
        overflow: visible;
        opacity: 1;
        pointer-events: auto;
        transform-origin: bottom right;
      }
      #${OVERLAY_ID} .cu-close-badge {
        position: absolute;
        top: -24px;
        right: 0;
        box-sizing: border-box;
        min-width: 72px;
        max-width: 180px;
        padding: 0 6px;
        text-align: center;
        font-size: 12px;
        line-height: 20px;
        font-weight: 700;
        color: #333;
        background: #ffffff;
        border: 1px solid #c7c7c7;
        border-radius: 4px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
      #${OVERLAY_ID}.is-expanded .cu-shell {
        width: 296px;
      }
      #${OVERLAY_ID}.is-hidden .cu-shell {
        opacity: 0;
        pointer-events: none;
      }
      #${OVERLAY_ID} .cu-header {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        min-height: 31px;
        border-bottom: 1px solid #d1d1d1;
        background: #ececec;
      }
      #${OVERLAY_ID} .cu-title {
        font-size: 12px;
        font-weight: 700;
        color: #363636;
      }
      #${OVERLAY_ID} .cu-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${OVERLAY_ID} .cu-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 1px solid #c6c6c6;
        border-radius: 4px;
        background: #f6f6f6;
        color: #444;
        cursor: pointer;
        padding: 0;
        transition: background 160ms ease, transform 160ms ease;
      }
      #${OVERLAY_ID} .cu-icon-btn:hover {
        background: #fff;
        transform: translateY(-1px);
      }
      #${OVERLAY_ID} .cu-icon-btn:disabled {
        opacity: 0.6;
        cursor: default;
        transform: none;
      }
      #${OVERLAY_ID} .cu-icon-btn svg {
        width: 12px;
        height: 12px;
      }
      #${OVERLAY_ID} .cu-mini-wrap {
        background: #f6f6f6;
        overflow: hidden;
        max-height: 74px;
        opacity: 1;
      }
      #${OVERLAY_ID}.is-expanded .cu-mini-wrap {
        max-height: 0;
        opacity: 0;
        pointer-events: none;
      }
      #${OVERLAY_ID} .cu-mini {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 42px 52px;
        align-items: center;
        column-gap: 8px;
        padding: 7px 10px;
        min-height: 31px;
        font-size: 12px;
        line-height: 1.1;
        background: #f6f6f6;
      }
      #${OVERLAY_ID} .cu-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 46px 92px;
        align-items: center;
        column-gap: 8px;
      }
      #${OVERLAY_ID} .cu-mini + .cu-mini {
        border-top: 1px solid #e3e3e3;
      }
      #${OVERLAY_ID} .cu-label {
        min-width: 0;
        font-weight: 600;
        color: #363636;
      }
      #${OVERLAY_ID} .cu-remaining {
        font-weight: 500;
        color: #363636;
      }
      #${OVERLAY_ID} .cu-mini .cu-remaining {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #${OVERLAY_ID} .cu-reset {
        color: #666;
        white-space: nowrap;
      }
      #${OVERLAY_ID} .cu-mini .cu-reset {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #${OVERLAY_ID} .cu-details {
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        border-top: 1px solid transparent;
        background: #f6f6f6;
      }
      #${OVERLAY_ID}.is-expanded .cu-details {
        max-height: 240px;
        opacity: 1;
        border-top-color: #d1d1d1;
      }
      #${OVERLAY_ID}.is-refreshing #cu-refresh-head svg {
        animation: cu-refresh-spin 900ms linear infinite;
        transform-origin: center;
      }
      #${OVERLAY_ID}.is-refreshing #cu-refresh {
        background: #ffffff;
        color: #2f2f2f;
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
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #${OVERLAY_ID} .cu-row .cu-reset {
        text-align: right;
        font-variant-numeric: tabular-nums;
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
        transition: background 160ms ease, transform 160ms ease;
      }
      #${OVERLAY_ID} .cu-action:hover {
        background: #fff;
        transform: translateY(-1px);
      }
      #${OVERLAY_ID} .cu-action:disabled {
        opacity: 0.6;
        cursor: default;
        transform: none;
      }
    </style>
    <button type="button" class="cu-restore" id="cu-restore" aria-label="恢复Codex余额">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="4" y="4" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.25"></rect>
        <path d="M6.4 8H9.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>
        <path d="M8 6.4V9.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"></path>
      </svg>
    </button>
    <div class="cu-shell">
      <span class="cu-close-badge" id="cu-battery-badge" aria-live="polite">读取电量</span>
      <div class="cu-header">
        <span class="cu-title">Codex余额</span>
        <div class="cu-header-actions">
          <button type="button" class="cu-icon-btn" id="cu-refresh-head" aria-label="刷新">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13 4.5V1.5M13 1.5H10M13 1.5L9.8 4.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
              <path d="M13 8a5 5 0 1 1-1.46-3.54" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
            </svg>
          </button>
          <button type="button" class="cu-icon-btn" id="cu-toggle" aria-label="展开详情" aria-expanded="false">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <g id="cu-toggle-expand">
                <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.3"></rect>
              </g>
              <g id="cu-toggle-collapse" style="display:none">
                <rect x="3.5" y="5" width="7.5" height="7.5" rx="1" stroke="currentColor" stroke-width="1.3"></rect>
                <rect x="5" y="3.5" width="7.5" height="7.5" rx="1" stroke="currentColor" stroke-width="1.3"></rect>
              </g>
            </svg>
          </button>
          <button type="button" class="cu-icon-btn" id="cu-close" aria-label="关闭">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="cu-mini-wrap">
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

  const refreshHeadButton = root.querySelector("#cu-refresh-head");
  const refreshButton = root.querySelector("#cu-refresh");

  const setRefreshing = (refreshing) => {
    root.classList.toggle("is-refreshing", refreshing);
    refreshHeadButton.disabled = refreshing;
    refreshButton.disabled = refreshing;
    refreshButton.textContent = refreshing ? "刷新中" : "刷新";
  };

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshOverlay(true);
    } finally {
      setRefreshing(false);
    }
  };

  const restoreButton = root.querySelector("#cu-restore");
  restoreButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    restoreOverlay(root);
  });

  refreshHeadButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await doRefresh();
  });

  const toggleButton = root.querySelector("#cu-toggle");
  toggleButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = root.classList.toggle("is-expanded");
    syncToggleIcon(root, expanded);
  });

  const closeButton = root.querySelector("#cu-close");
  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    minimizeOverlay(root);
  });

  const detailButton = root.querySelector("#cu-detail");
  detailButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.open(USAGE_URL, "_blank", "noopener,noreferrer");
  });

  refreshButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await doRefresh();
  });

  syncToggleIcon(root, false);
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
  weeklyReset.textContent = formatDetailReset(snapshot.weekly.resetAt);
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
  refreshBatteryBadge();
  refreshOverlay(false);
  window.setInterval(() => {
    refreshBatteryBadge();
  }, BATTERY_REFRESH_MS);
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



