// LINE Messaging API Webhook（Vercel Function / Next.js App Router Route Handler）
// 有人加入群組 → 自動回歡迎訊息並 @ 新成員；機器人被拉進群組 → 自我介紹
// 需要在 Vercel 設定環境變數：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN
import crypto from 'node:crypto';

const LIFF_URL = 'https://liff.line.me/2012621364-BTCqnFfK';

// 驗證請求真的來自 LINE（用 Channel secret 對原始內容做 HMAC-SHA256）
function isValidSignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function reply(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('reply failed', res.status, await res.text());
}

// 歡迎訊息：用 textV2 的 {m0}、{m1}… 佔位符 @ 每位新成員
function welcomeMessage(members) {
  const users = members.filter((m) => m.type === 'user').slice(0, 20);
  if (!users.length) return null;
  const substitution = {};
  users.forEach((m, i) => {
    substitution[`m${i}`] = { type: 'mention', mentionee: { type: 'user', userId: m.userId } };
  });
  const names = users.map((_, i) => `{m${i}}`).join(' ');
  return {
    type: 'textV2',
    text: `👋 歡迎 ${names} 加入！\n\n🏓 進擊的匹克團｜雙場分級包場計畫\n1～2 月體驗期單次只要 160 元／人，3 月起正式推出會員方案！\n\n📣 報名打球請點連結，或點群組裡最新的接龍卡片「我要報名」，額滿會自動排候補：\n${LIFF_URL}`,
    substitution,
  };
}

async function handleEvent(event) {
  if (event.type === 'memberJoined') {
    const msg = welcomeMessage(event.joined?.members || []);
    if (msg) await reply(event.replyToken, [msg]);
  } else if (event.type === 'join') {
    await reply(event.replyToken, [{
      type: 'text',
      text: `大家好，我是匹克球小幫手 🏓\n有新朋友加入時我會打招呼。\n\n發起接龍請點：\n${LIFF_URL}`,
    }]);
  }
}

export async function POST(request) {
  const rawBody = await request.text();
  if (!isValidSignature(rawBody, request.headers.get('x-line-signature'))) {
    return new Response('invalid signature', { status: 401 });
  }
  const { events = [] } = JSON.parse(rawBody);
  // LINE 後台按「Verify」時 events 是空陣列，直接回 200 即可
  await Promise.all(events.map((e) => handleEvent(e).catch((err) => console.error(err))));
  return new Response('ok');
}

export function GET() {
  return new Response('pickleball line bot is running');
}
