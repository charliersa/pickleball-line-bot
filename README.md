# pickleball-line-bot

進擊的匹克團 LINE 群組歡迎機器人（LINE Messaging API webhook）。

- 有新成員加入群組 → 自動回覆歡迎訊息，並 @ 提及新成員，附上報名連結
- 機器人被拉進群組 → 自我介紹
- 群組輸入「取消報名」或「請假」→ 直接取消最新一場的報名（會員則登記本次請假），回覆 @ 本人的確認 + 最新名單卡
- 機器人名單卡上的「取消報名」是 postback 按鈕：在聊天室按一下就取消，不用開網頁

需要 Firebase 規則：`chains` 有 `".read": true` 與 `".indexOn": ["createdAt"]`（見 pickleball-attack 的 firebase-rules-chains.json）。

## 部署（Vercel）

這是一個 Next.js App Router 專案，webhook 路徑在 `app/api/webhook/route.js`，對應網址為 `/api/webhook`。

**需要的環境變數**（Vercel 專案 → Settings → Environment Variables）：

- `LINE_CHANNEL_SECRET` — LINE Developers Console → Messaging API → Channel secret
- `LINE_CHANNEL_ACCESS_TOKEN` — LINE Developers Console → Messaging API → Channel access token（長期）

**LINE 後台設定**：Webhook URL 填 `https://<你的網域>/api/webhook`，並開啟「Use webhook」。機器人本身也要先被邀請加入 LINE 群組，才收得到新成員加入的事件。

**部署方式**：請用「連接 GitHub repo」讓 Vercel 自動部署（Settings → Git → Connect），不要再用 `vercel deploy` CLI 直接上傳，否則程式碼改了也不會真的套用到正式網址。
