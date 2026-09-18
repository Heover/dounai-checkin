/** Only structural UI facts and response status; never credentials, images, or tokens. */
export async function readCaptchaControls(page) {
  try {
    return await page.locator('[id*="captcha"], [id*="checkin"], [role="dialog"]').evaluateAll((nodes) => nodes.map((el) => ({
      id: el.id,
      tag: el.tagName.toLowerCase(),
      visible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height) && getComputedStyle(el).visibility !== "hidden",
      role: el.getAttribute("role"),
      children: [...new Set(Array.from(el.children).map((child) => child.tagName.toLowerCase()))],
      buttons: Array.from(el.querySelectorAll('button, [role="button"]')).map((button) => ({
        id: button.id, label: (button.textContent || "").replace(/[^\u3400-\u9fff]/g, "").slice(0, 30),
      })),
    })));
  } catch { return { unavailable: true }; }
}

export function diagnosticEndpoint(request) {
  try {
    const url = new URL(request.url());
    if (url.origin !== "https://dounai.win") return null;
    const labels = { "/auth/login": "login", "/auth/captcha": "login-captcha", "/user/checkin": "checkin", "/user/checkin/captcha": "checkin-captcha" };
    return labels[url.pathname] || null;
  } catch { return null; }
}

export function installPageDiagnostics(page, log = console.log) {
  const started = performance.now();
  const requests = new WeakMap();
  let sequence = 0;
  let active = true;
  const emit = (event, details = {}) => {
    if (active) log(`页面诊断: ${JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...details })}`);
  };
  const metadata = (request) => {
    const endpoint = diagnosticEndpoint(request);
    if (!endpoint) return null;
    if (!requests.has(request)) requests.set(request, { id: ++sequence, started: performance.now(), endpoint });
    const item = requests.get(request);
    const method = request.method();
    return { id: item.id, endpoint, method: ["GET", "POST"].includes(method) ? method : "other", durationMs: Math.round(performance.now() - item.started) };
  };
  const onRequest = (request) => {
    const info = metadata(request);
    if (info) emit("request", info);
  };
  const onFailed = (request) => {
    const info = metadata(request);
    if (!info) return;
    const detail = request.failure()?.errorText || "";
    const reason = /TIMED_OUT/i.test(detail) ? "timeout" : /NAME_NOT_RESOLVED/i.test(detail) ? "dns" : /CERT_/i.test(detail) ? "certificate" : /ABORTED/i.test(detail) ? "aborted" : "network-error";
    emit("request-failed", { ...info, reason });
  };
  const onError = (error) => emit("page-error", { type: ["TypeError", "ReferenceError", "SyntaxError", "RangeError"].includes(error.name) ? error.name : "Error" });
  const onResponse = async (response) => {
    try {
      const info = metadata(response.request());
      if (!info) return;
      let body;
      let json = true;
      try { body = await response.json(); } catch { json = false; }
      emit("response", {
        ...info, status: response.status(), json,
        ret: Number.isFinite(body?.ret) ? body.ret : null,
        blocked: body?.is_blocked === true,
        hasImage: typeof body?.svg === "string" && !!body.svg,
        messageType: /锁定|检测到签到脚本/.test(body?.msg || "") ? "blocked" : /验证码.*(?:错误|超时|过期|失效)/.test(body?.msg || "") ? "captcha-rejected" : /刷新/.test(body?.msg || "") ? "refresh-required" : /已签到|已经签到/.test(body?.msg || "") ? "already-checked-in" : "other",
      });
    } catch { /* Diagnostic failures must not affect the page workflow. */ }
  };
  page.on("request", onRequest);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  page.on("pageerror", onError);
  return () => {
    active = false;
    page.off("request", onRequest); page.off("requestfailed", onFailed);
    page.off("response", onResponse); page.off("pageerror", onError);
  };
}
