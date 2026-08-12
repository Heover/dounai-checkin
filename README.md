# 豆奶自动签到

每日自动登录 [dounai.win](https://dounai.win) 并签到，获取免费流量，通过 Server酱3 推送结果到微信。

## 工作流

```
获取验证码并识别 → 登录 → 访问面板建立会话 → 签到 → Server酱3 推送
```

## 定时

每天北京时间 **00:07** 自动执行（GitHub Actions cron）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `DOUNAI_EMAIL` | 豆奶账号邮箱 |
| `DOUNAI_PASSWD` | 豆奶账号密码 |
| `SERVER_UID` | Server酱3 UID（组织级共享） |
| `SERVER_KEY` | Server酱3 SendKey（组织级共享） |

## 本地调试

```bash
# 安装依赖（tesseract.js 用于识别登录验证码）
npm install

# 创建 .env 文件
echo "DOUNAI_EMAIL=your@email.com" > .env
echo "DOUNAI_PASSWD=your_password" >> .env
echo "SERVER_UID=your_uid" >> .env
echo "SERVER_KEY=your_key" >> .env

# 运行
npm run checkin
```

> 首次运行 tesseract.js 会从 CDN 下载 OCR 模型（约 15MB），之后自动缓存。

## 技术栈

- Node.js 20+（tesseract.js 验证码识别，无需 Python 环境）
- GitHub Actions 定时调度
- Server酱3 消息推送
