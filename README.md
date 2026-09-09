# 豆奶全自动页面签到

程序打开浏览器页面，自动登录、识别验证码、点击签到并发送 Server 酱3 通知。
没有人工填验证码、终端确认或交接步骤。每日北京时间 **00:07** 自动执行，亦支持手动触发。

## 实现方式

- 使用 Playwright 正常打开页面，由网页自身提交登录和签到请求，不重放接口或读取隐藏令牌。
- 仅截取验证码小图，发送到 DeepSeek 官方 API 的 `deepseek-v4-flash-vision-exp` 视觉模型。
- 模型输出算式及答案，程序独立复算，支持中文/大写数字与加减乘除；不确定或不一致则停止。
- 登录页输入验证码会自动提交，不额外点击登录；签到页填写后点击确认。
- 登录和签到各最多提交三次；服务端要求整页刷新时最多刷新一次。明确锁定立即停止。
- 不修改浏览器指纹、隐藏自动化属性、解除站点锁定或禁用证书校验。

模型请求限时 20 秒、输出最多 256 tokens，关闭思考模式。只上传验证码区域，
不发送账号密码、Cookie、订阅链接或整页截图；截图不写入仓库或工作流 artifact。

参考：[DeepSeek 图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)、
[思考模式参数](https://api-docs.deepseek.com/guides/thinking_mode/)。API 调用会消耗 DeepSeek 余额。

## 本地运行

需要 Node.js 20+ 和已安装的 Chrome 或 Edge。将 `.env.example` 复制为 `.env` 并填写配置，
也可通过环境变量传入。不要将真实凭据提交到仓库。

```bash
npm ci
npm run checkin
```

默认 Chrome；Edge 设置 `CHECKIN_BROWSER=msedge`。使用临时独立会话，不读取日常浏览器
密码/Cookie，不持久化登录状态。结束后自动关闭浏览器，不等待按键。

| 变量 | 说明 |
|------|------|
| `DOUNAI_EMAIL` | 必填，账号邮箱 |
| `DOUNAI_PASSWD` | 必填，密码 |
| `DEEPSEEK_API_KEY` | 必填，DeepSeek API Key，需有视觉模型权限及余额 |
| `CHECKIN_BROWSER` | `chrome`（默认）、`msedge` 或 `chromium` |
| `CHECKIN_TIMEOUT_MS` | 页面响应等候上限，默认 `30000`，范围 `1000–120000` 毫秒 |
| `SERVER_UID` / `SERVER_KEY` | 可选，Server 酱3 通知 |

## GitHub Actions

仓库或仓库可访问的组织 Secrets 中配置账号密码、`DEEPSEEK_API_KEY` 及通知凭据。
组织 Secret 必须授权此仓库访问。工作流安装官方 Chrome，使用 Xvfb 虚拟显示运行有界面浏览器，
自动识别验证码，不需要连接桌面。并发组避免定时和手动运行同时操作账号。

缺少配置、API 异常或网页流程失败时以非零退出码结束，并在通知已配置时推送失败。
每日定时保持启用，但改为运行浏览器入口，不再自动执行旧 HTTP/OCR 脚本。

## 成功判断及验证范围

2026-09-09 在本地内置浏览器通过页面操作成功得到 **257 MB 流量、1 个豆丁、1.5 小时有效期**。
这是页面路径可行的实测，不等于新程序在 GitHub 云环境已成功，也不能保证今后不被站点识别。

页面曾提示“请刷新页面后重试”，却将按钮改成“今日已签到”，实际未入账。
因此 `ret=1` 或提交后按钮变化不单独作为成功依据：响应须有明确奖励或已签到文案。
仅首次进入面板或重新加载后才采用页面已签到状态。

验证码识别能力与站点脚本检测是两个问题。DeepSeek 能否正确识别需实际运行验证；
即使验证码正确，站点仍可能拒绝自动化。发生 `is_blocked: true` 时程序停止，不能解除锁定。

```bash
npm test
npm run checkin -- --help
# 旧 HTTP/OCR 入口仅供明确需要时排查，仍可能被网站锁定
npm run checkin:legacy
```
