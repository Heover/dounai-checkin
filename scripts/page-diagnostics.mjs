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

export function installPageDiagnostics(page, log = console.log) {
  const onError = (error) => log(`页面脚本错误类型: ${error.name || "Error"}`);
  const onResponse = async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== "https://dounai.win" || !/captcha|checkin/i.test(url.pathname)) return;
      const type = response.request().resourceType();
      if (!["xhr", "fetch"].includes(type)) return;
      const body = await response.json();
      log(`页面验证码请求: ${JSON.stringify({
        method: response.request().method(), status: response.status(),
        ret: typeof body?.ret === "number" ? body.ret : null,
        blocked: body?.is_blocked === true,
        hasImage: typeof body?.svg === "string" && !!body.svg,
        message: typeof body?.msg === "string" ? body.msg.replace(/[^\u3400-\u9fff，。：；！、\s]/g, "").slice(0, 80) : null,
      })}`);
    } catch { /* Diagnostic failures must not affect the page workflow. */ }
  };
  page.on("response", onResponse);
  page.on("pageerror", onError);
  return () => { page.off("response", onResponse); page.off("pageerror", onError); };
}
