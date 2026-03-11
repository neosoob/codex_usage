const shortRemainingEl = document.getElementById("shortRemaining");
const weeklyRemainingEl = document.getElementById("weeklyRemaining");
const shortResetEl = document.getElementById("shortReset");
const weeklyResetEl = document.getElementById("weeklyReset");
const statusEl = document.getElementById("status");
const hintsEl = document.getElementById("hints");
const refreshButton = document.getElementById("refresh");

function setList(element, items, emptyText) {
  element.innerHTML = "";

  const source = items && items.length ? items : [emptyText];
  for (const item of source) {
    const li = document.createElement("li");
    li.textContent = item;
    element.appendChild(li);
  }
}

function renderSnapshot(snapshot) {
  shortRemainingEl.textContent = snapshot.shortTerm.remaining || "--";
  weeklyRemainingEl.textContent = snapshot.weekly.remaining || "--";
  shortResetEl.textContent = `重置时间：${snapshot.shortTerm.resetAt || "--"}`;
  weeklyResetEl.textContent = `重置时间：${snapshot.weekly.resetAt || "--"}`;
  statusEl.textContent = `已读取 usage 页面，时间 ${new Date(snapshot.scannedAt).toLocaleString("zh-CN")}`;
  setList(hintsEl, snapshot.hints, "没有额外线索。");
}

function renderError(message) {
  shortRemainingEl.textContent = "--";
  weeklyRemainingEl.textContent = "--";
  shortResetEl.textContent = "重置时间：--";
  weeklyResetEl.textContent = "重置时间：--";
  statusEl.textContent = message;
  setList(hintsEl, [], "请先登录 chatgpt.com 后再试。");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadFromStorage() {
  const stored = await chrome.storage.local.get("codexUsageSnapshot");
  return stored?.codexUsageSnapshot || null;
}

async function requestSnapshot(forceRefresh = false) {
  const tab = await getActiveTab();

  if (!tab?.id || !tab.url || !/https:\/\/([^.]+\.)?chatgpt\.com\//i.test(tab.url)) {
    const cached = await loadFromStorage();
    if (cached) {
      renderSnapshot(cached);
      return;
    }
    renderError("请先切到 chatgpt.com 页面，或先让扩展读取一次。");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_CODEX_USAGE",
      forceRefresh
    });

    if (response?.ok && response.snapshot) {
      renderSnapshot(response.snapshot);
      return;
    }

    throw new Error(response?.error || "页面没有返回结果");
  } catch (error) {
    const cached = await loadFromStorage();
    if (cached) {
      renderSnapshot(cached);
      statusEl.textContent = `实时读取失败，已显示缓存：${error.message}`;
      return;
    }
    renderError(`读取失败：${error.message}`);
  }
}

refreshButton.addEventListener("click", () => requestSnapshot(true));
requestSnapshot(false);
