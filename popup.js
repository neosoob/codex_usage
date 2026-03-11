const remainingEl = document.getElementById("remaining");
const usagePairEl = document.getElementById("usagePair");
const resetAtEl = document.getElementById("resetAt");
const statusEl = document.getElementById("status");
const hintsEl = document.getElementById("hints");
const linesEl = document.getElementById("lines");
const refreshButton = document.getElementById("refresh");

function setList(element, items, emptyText) {
  element.innerHTML = "";

  if (!items || items.length === 0) {
    const li = document.createElement("li");
    li.textContent = emptyText;
    element.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    element.appendChild(li);
  }
}

function render(snapshot) {
  remainingEl.textContent = snapshot.remaining || "--";
  usagePairEl.textContent =
    snapshot.used || snapshot.limit
      ? `${snapshot.used || "--"} / ${snapshot.limit || "--"}`
      : "--";
  resetAtEl.textContent = snapshot.resetAt || "--";

  const time = new Date(snapshot.scannedAt).toLocaleString("zh-CN");
  statusEl.textContent = `已扫描 ${snapshot.title || "当前页面"}，时间 ${time}`;
  setList(hintsEl, snapshot.hints, "没有匹配到明确的额度字段。");
  setList(linesEl, snapshot.relevantLines, "页面里没有找到明显的用量关键词。");
}

function renderError(message) {
  remainingEl.textContent = "--";
  usagePairEl.textContent = "--";
  resetAtEl.textContent = "--";
  statusEl.textContent = message;
  setList(hintsEl, [], "请先打开展示 Codex 用量的页面。");
  setList(linesEl, [], "当前标签页没有可扫描内容。");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function scanActiveTab() {
  const tab = await getActiveTab();

  if (!tab?.id || !tab.url) {
    renderError("拿不到当前标签页。");
    return;
  }

  const isSupported = /https:\/\/([^.]+\.)?(chatgpt|openai)\.com\//i.test(tab.url);
  if (!isSupported) {
    renderError("请先切到 chatgpt.com 或 openai.com 的相关页面。");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CODEX_USAGE" });
    if (!response) {
      renderError("页面还没注入脚本，刷新目标页面后再试。");
      return;
    }

    render(response);
  } catch (error) {
    renderError(`扫描失败：${error.message}`);
  }
}

refreshButton.addEventListener("click", scanActiveTab);
scanActiveTab();
