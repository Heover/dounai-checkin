import test from "node:test";
import assert from "node:assert/strict";
import { describeLaunchError } from "./checkin-browser.mjs";

test("浏览器启动错误仅输出安全分类，不输出原始调用日志", () => {
  for (const [message, expected] of [["No usable sandbox secret", "沙箱"],
    ["Missing X server or DISPLAY secret", "显示环境"], ["Executable does not exist secret", "不存在"],
    ["other secret", "无法启动"]]) {
    const output = describeLaunchError(new Error(message), "chrome");
    assert.ok(output.includes(expected)); assert.ok(!output.includes("secret"));
  }
});
