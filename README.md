# pickleball-line-bot

進擊的匹克團 LINE 群組歡迎機器人（LINE Messaging API webhook）。

- 有新成員加入群組 → 自動回覆歡迎訊息，並 @ 提及新成員，附上報名連結
- 機器人被拉進群組 → 自我介紹

## 部署（Vercel）

這是一個 Next.js App Router 專案，webhook 路徑在 `app/api/webhook/route.js`，對應網址為 `/api/webhook`。

**需要的環境變數**（Vercel 專案 → Settings → Environment Variables）：

- `LINE_CHANNEL_SECRET` — LINE Developers Console → Messaging API → Channel secret
- `LINE_CHANNEL_ACCESS_TOKEN` — LINE Developers Console → Messaging API → Channel access token（長期）

**LINE 後台設定**：Webhook URL 填 `https://<你的網域>/api/webhook`，並開啟「Use webhook」。機器人本身也要先被邀請加入 LINE 群組，才收得到新成員加入的事件。
