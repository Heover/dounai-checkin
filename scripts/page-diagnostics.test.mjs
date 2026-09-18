import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { diagnosticEndpoint, installPageDiagnostics } from "./page-diagnostics.mjs";

const request = (pathname = "/user/checkin/captcha") => ({
  url: () => `https://dounai.win${pathname}?token=SECRET_TOKEN`,
  method: () => "GET",
  failure: () => ({ errorText: "net::ERR_TIMED_OUT SECRET_PASSWORD" }),
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test("仅标记站内明确端点，不记录查询参数或其他站点", () => {
  for (const [path, label] of [["/auth/login", "login"], ["/auth/captcha", "login-captcha"],
    ["/user/checkin", "checkin"], ["/user/checkin/captcha", "checkin-captcha"]]) {
    assert.equal(diagnosticEndpoint(request(path)), label);
  }
  assert.equal(diagnosticEndpoint(request("/user/secret")), null);
  assert.equal(diagnosticEndpoint({ url: () => "https://evil.example/auth/login" }), null);
});

test("请求日志包含关联序号和状态，但不泄露响应消息、图片或网络错误原文", async () => {
  const page = new EventEmitter();
  const lines = [];
  const stop = installPageDiagnostics(page, line => lines.push(line));
  const req = request();
  page.emit("request", req);
  page.emit("response", { request: () => req, status: () => 200,
    json: async () => ({ ret: 0, is_blocked: true, svg: "SECRET_IMAGE", msg: "检测到签到脚本 SECRET_KEY 隐私内容" }) });
  page.emit("requestfailed", req);
  page.emit("pageerror", { name: "SECRET_ERROR" });
  await tick();
  const output = lines.join("\n");
  assert.doesNotMatch(output, /SECRET|隐私内容|token=|https:/);
  const records = lines.map(line => JSON.parse(line.slice(line.indexOf("{"))));
  const response = records.find(record => record.event === "response");
  assert.equal(response.id, records[0].id);
  assert.equal(response.blocked, true);
  assert.equal(response.messageType, "blocked");
  assert.equal(response.status, 200);
  assert.ok(response.durationMs >= 0);
  assert.equal(records.find(record => record.event === "request-failed").reason, "timeout");
  stop();
  for (const event of ["request", "response", "requestfailed", "pageerror"]) assert.equal(page.listenerCount(event), 0);
});

test("非 JSON 响应仍记录 HTTP 状态，注销后异步响应不再输出", async () => {
  const page = new EventEmitter();
  const lines = [];
  const stop = installPageDiagnostics(page, line => lines.push(line));
  page.emit("response", { request: () => request(), status: () => 503, json: async () => { throw Error("SECRET_BODY"); } });
  await tick();
  assert.match(lines[0], /"status":503,"json":false/);
  let resolve;
  page.emit("response", { request: () => request(), status: () => 200, json: () => new Promise(done => { resolve = done; }) });
  stop();
  resolve({ ret: 1 });
  await tick();
  assert.equal(lines.length, 1);
});
