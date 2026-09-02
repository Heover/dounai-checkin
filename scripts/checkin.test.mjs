import assert from "node:assert/strict";
import test from "node:test";

import { CookieJar, isCaptchaError } from "./checkin.mjs";

test("CookieJar 用最新值覆盖同名会话 Cookie", () => {
  const jar = new CookieJar();
  jar.update([
    "PHPSESSID=old-session; path=/; HttpOnly",
    "uid=123; path=/",
  ]);
  jar.update(["PHPSESSID=new-session; path=/; HttpOnly"]);

  assert.equal(jar.size, 2);
  assert.equal(jar.toHeader(), "PHPSESSID=new-session; uid=123");
});

test("识别签到端验证码错误与超时消息", () => {
  assert.equal(isCaptchaError("验证码错误或已超时，请刷新重试"), true);
  assert.equal(isCaptchaError("验证码已过期"), true);
  assert.equal(isCaptchaError("会话未认证，登录状态无效"), false);
});
