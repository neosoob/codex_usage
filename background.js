const BATTERY_API_BASE_URL = "http://127.0.0.1:46839";
const BATTERY_API_PASSWORD = "";

let batteryInflightPromise = null;

function getBatteryApiUrl(path) {
  return `${BATTERY_API_BASE_URL.replace(/\/+$/, "")}${path}`;
}

async function loginBatteryApi() {
  if (!BATTERY_API_PASSWORD) {
    throw new Error("未配置电量接口密码");
  }

  const response = await fetch(getBatteryApiUrl("/login"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ password: BATTERY_API_PASSWORD }),
    credentials: "include",
    redirect: "manual"
  });

  if (response.status === 401) {
    throw new Error("电量接口密码错误");
  }
  if (response.status === 429) {
    throw new Error("电量接口登录过于频繁");
  }
  if (!response.ok && response.type !== "opaqueredirect" && !(response.status >= 300 && response.status < 400)) {
    throw new Error(`电量接口登录失败：${response.status}`);
  }
}

async function fetchLatestBatteryOnce() {
  const response = await fetch(getBatteryApiUrl("/latest"), {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  });

  if (response.status === 401) {
    await loginBatteryApi();
    const retryResponse = await fetch(getBatteryApiUrl("/latest"), {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    });

    if (!retryResponse.ok) {
      throw new Error(`电量接口读取失败：${retryResponse.status}`);
    }
    return retryResponse.json();
  }

  if (!response.ok) {
    throw new Error(`电量接口读取失败：${response.status}`);
  }

  return response.json();
}

async function fetchLatestBattery() {
  if (batteryInflightPromise) {
    return batteryInflightPromise;
  }

  batteryInflightPromise = fetchLatestBatteryOnce();

  try {
    return await batteryInflightPromise;
  } finally {
    batteryInflightPromise = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_BATTERY_API_BASE_URL") {
    sendResponse({ ok: true, baseUrl: BATTERY_API_BASE_URL });
    return false;
  }

  if (message?.type !== "GET_LATEST_BATTERY") {
    return false;
  }

  fetchLatestBattery()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
