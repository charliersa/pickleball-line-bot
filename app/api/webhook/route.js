// LINE Messaging API Webhook（Vercel Function / Next.js App Router Route Handler）
// - 有人加入群組 → 自動回歡迎訊息並 @ 新成員；機器人被拉進群組 → 自我介紹
// - 群組裡輸入「取消報名」或「請假」→ 直接取消最新一場的報名（會員則登記本次請假），回覆最新名單卡
// - 機器人回覆的名單卡上「取消報名」按鈕是 postback：在聊天室按一下就取消，不用開網頁
//   （報名者從網站發的名單卡，LINE 規定按鈕只能開網址，所以一鍵取消只能由機器人的卡片提供）
// 需要在 Vercel 設定環境變數：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN
import crypto from 'node:crypto';

const LIFF_URL = 'https://liff.line.me/2012621364-BTCqnFfK';
// 跟報名系統（pickleball-attack 的 index.js）共用同一個 Firebase 專案
const DB_URL = 'https://pickleball-ad66b-default-rtdb.asia-southeast1.firebasedatabase.app';
const CANCEL_WORDS = ['取消報名', '請假'];
const RECENT_CHAINS = 6;      // 「取消報名」從最近建立的幾場接龍裡找
const COURT_SIZE = 8;         // 每面上限人數（跟試算表「營運總覽」一致）
const FLEX_MAX_ROWS = 40;
const PLANS = ['季繳', '月繳'];
const DAY_LABEL = { sun: '週日', fri: '週五' };
// 場地固定是鹿角 4、5 號場；改版前的 6、7 號場接龍與舊格式會員不再處理
const COURT_NOS = ['4', '5'];

const chainUrl = (id) => `${LIFF_URL}?e=${encodeURIComponent(id)}`;

// ---------- Firebase REST ----------
async function db(path, { method = 'GET', body, query = '' } = {}) {
  const res = await fetch(`${DB_URL}/${path}.json${query}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firebase ${method} ${path} 失敗：${res.status} ${await res.text()}`);
  return res.json();
}

// 最近建立的接龍（新的在前）
// 優先用 Firebase 依 createdAt 查詢（需要規則 .indexOn: ["createdAt"]）；索引沒設好時改成讀全部接龍自己排序
async function recentChains(limit) {
  let data;
  try {
    data = await db('chains', { query: `?orderBy=${encodeURIComponent('"createdAt"')}&limitToLast=${limit}` });
  } catch (err) {
    console.warn('依 createdAt 查詢失敗，改讀全部接龍', err.message);
    data = await db('chains');
  }
  return Object.entries(data || {})
    .map(([id, c]) => ({ id, ...c }))
    .filter((c) => c && 'price' in c && chainCourts(c).length) // 跳過沒有 4、5 號場的舊接龍
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

// 接龍只存「1/3（日）」：依建立時間推年份（例如 11 月開 1 月的團算成隔年）
function chainIso(c) {
  const m = String(c.date || '').match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  const created = new Date((c.createdAt || Date.now()) + 8 * 3600e3); // 台灣時間
  let y = created.getUTCFullYear();
  const mo = Number(m[1]);
  if (mo < created.getUTCMonth() + 1 - 6) y += 1;
  return `${y}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

const todayIso = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

// 歡迎訊息用的報名場次：還沒打的場次，週五、週日各取最近的一場（同一天開了好幾次團取最後建立的）
// 都沒有就退回最新建立的一場；再沒有（或查詢失敗）回傳空陣列，卡片改放主連結
async function upcomingChains() {
  try {
    const list = await recentChains(12);
    const today = todayIso();
    const pick = {};
    for (const c of list) { // list 是新建立的在前，同日期保留第一個（最新建立）
      const iso = chainIso(c);
      if (!iso || iso < today) continue;
      const d = chainDay(c);
      if (!pick[d] || iso < pick[d].iso) pick[d] = { ...c, iso };
    }
    const upcoming = Object.values(pick).sort((a, b) => a.iso.localeCompare(b.iso));
    return upcoming.length ? upcoming : list.slice(0, 1);
  } catch (err) {
    console.error('查詢接龍失敗', err);
    return [];
  }
}

// ---------- 跟網站相同的名額邏輯（index.js） ----------
function normalizeMember(key, m) {
  const court = String(m?.court);
  if (!m || !PLANS.includes(m.plan) || !COURT_NOS.includes(court) || !DAY_LABEL[m.day]) return null;
  if (key !== `${key.split('_')[0]}_${m.day}`) return null; // key 結尾要跟時段一致
  return {
    key,
    lineId: key.split('_')[0],
    name: String(m.name || '會員'),
    plan: m.plan,
    day: m.day,
    court,
  };
}

function cleanMembers(val) {
  return Object.entries(val || {}).map(([k, m]) => normalizeMember(k, m)).filter(Boolean);
}

const chainDay = (c) => (DAY_LABEL[c.day] ? c.day : 'sun');

function memberOf(uid, day, members) {
  return members.find((m) => m.key === `${uid}_${day}`) || null;
}

// 只取 4、5 號場；沒存 courts 的舊接龍回傳空陣列
function chainCourts(c) {
  const src = c.courts || {};
  return Object.keys(src).filter((no) => COURT_NOS.includes(no)).sort((a, b) => a - b)
    .map((no) => ({ no, name: src[no].name, level: src[no].level }));
}

const friendList = (e) => Object.values(e?.friends || {}).filter(Boolean);
const headsOf = (e) => (e.self === false ? 0 : 1) + (e.guests || 0);
const friendDuprs = (e) => Array.from({ length: e?.guests || 0 }, (_, i) => e.friendDupr?.[i] || null);
const withDupr = (name, d) => (d ? `${name} ${d}` : name);

function personLabel(e) {
  const fd = friendDuprs(e);
  const names = friendList(e).map((n, i) => withDupr(n, fd[i]));
  if (e.self === false) return names.length ? `${names.join('、')}（${e.name} 代報）` : `${e.name} 代報 ${e.guests} 位`;
  const me = withDupr(e.name, e.dupr);
  if (!e.guests) return me;
  return `${me} +${e.guests}${names.length ? `（${names.join('、')}）` : ''}`;
}

function splitEntries(list, capacity) {
  const sorted = [...list].sort((a, b) => (a.ts - b.ts) || a.uid.localeCompare(b.uid));
  const confirmed = [];
  const waitlist = [];
  let used = 0;
  for (const e of sorted) {
    const need = headsOf(e);
    if (!waitlist.length && used + need <= capacity) { confirmed.push(e); used += need; } else waitlist.push(e);
  }
  return { confirmed, waitlist, used };
}

function courtData(c, court, members) {
  const day = chainDay(c);
  const ms = members.filter((m) => m.day === day && m.court === court.no)
    .map((m) => ({ ...m, leave: !!c.leaves?.[m.key] }));
  const active = ms.filter((m) => !m.leave).length;
  const cap = Math.max(0, COURT_SIZE - active);
  const entries = Object.entries(c.entries || {}).filter(([, e]) => e.court === court.no).map(([uid, e]) => ({ uid, ...e }));
  const s = splitEntries(entries, cap);
  return { ...court, members: ms, active, cap, ...s, total: active + s.used };
}

function memberLine(cd) {
  const on = cd.members.filter((m) => !m.leave).map((m) => m.name);
  const off = cd.members.filter((m) => m.leave).map((m) => m.name);
  return `👑 會員 ${on.length}/${cd.members.length}：${on.join('、') || '—'}${off.length ? `（${off.join('、')} 請假）` : ''}`;
}

// ---------- 名單卡（跟網站的卡片相同，但「取消報名」是一鍵 postback） ----------
function infoRow(label, value) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#aaaaaa', size: 'sm', flex: 1 },
      { type: 'text', text: String(value || '—'), color: '#666666', size: 'sm', flex: 4, wrap: true },
    ],
  };
}

function buildChainFlex(c, members) {
  const courts = chainCourts(c).map((court) => courtData(c, court, members));
  const rows = [];
  let budget = FLEX_MAX_ROWS;
  const addList = (label, color, list) => {
    rows.push({ type: 'text', text: label, weight: 'bold', size: 'sm', color, margin: 'sm' });
    list.slice(0, budget).forEach((e, i) => rows.push({ type: 'text', text: `${i + 1}. ${personLabel(e)}`, size: 'sm', wrap: true }));
    if (list.length > budget) rows.push({ type: 'text', text: `…還有 ${list.length - budget} 位`, size: 'xs', color: '#aaaaaa' });
    budget = Math.max(0, budget - list.length);
  };
  for (const cd of courts) {
    rows.push({ type: 'separator', margin: 'lg' });
    rows.push({ type: 'text', text: `${cd.no}號場｜${cd.name}（${cd.level}）　${cd.total}/${COURT_SIZE}`, weight: 'bold', size: 'md', margin: 'lg', wrap: true });
    rows.push({ type: 'text', text: memberLine(cd), size: 'sm', color: '#555555', wrap: true });
    addList(`單次正取 ${cd.used}/${cd.cap}`, '#1DB446', cd.confirmed);
    if (!cd.confirmed.length) rows.push({ type: 'text', text: '（還沒有人報名）', size: 'sm', color: '#aaaaaa' });
    if (cd.waitlist.length) addList(`候補 ${cd.waitlist.length} 組`, '#FF8C00', cd.waitlist);
  }
  const day = DAY_LABEL[chainDay(c)];
  const alt = courts.map((cd) => `${cd.no}號 ${cd.total}/${COURT_SIZE}`).join('、');
  return {
    type: 'flex',
    altText: `【接龍】${c.title} ${alt}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: c.week ? `🏓 進擊的匹克團｜${day}第 ${c.week} 場` : `🏓 進擊的匹克團｜${day}`, size: 'xs', color: '#1DB446', weight: 'bold' },
          { type: 'text', text: c.title, weight: 'bold', size: 'xl', wrap: true },
          infoRow('日期', c.date),
          infoRow('時間', c.time),
          infoRow('地點', c.place),
          infoRow('單次', `${typeof c.price === 'number' ? c.price : 180} 元／人`),
          ...(c.note ? [infoRow('備註', c.note)] : []),
          ...rows,
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'button', style: 'primary', color: '#1DB446', flex: 3, action: { type: 'uri', label: '我要報名 / 修改', uri: chainUrl(c.id) } },
              { type: 'button', style: 'secondary', flex: 2, action: { type: 'postback', label: '取消報名', data: `a=cancel&e=${c.id}`, displayText: '取消報名' } },
            ],
          },
          { type: 'text', text: '💬 也可以在群組輸入「取消報名」或「請假」', size: 'xxs', color: '#aaaaaa', align: 'center' },
        ],
      },
    },
  };
}

// ---------- 取消報名 ----------
// 報名 key 是「LINE ID_場地」
const myEntryKeys = (c, uid) => Object.keys(c.entries || {}).filter((k) => k.startsWith(`${uid}_`));

// 取消 uid 的報名：有單次報名 → 全部取消；沒有但是會員 → 本次請假。
// onlyChainId 有值（按卡片按鈕）只處理那一場；沒有（打字）就從最近幾場找最新一筆有關的
async function cancelFor(uid, onlyChainId) {
  const [chains, membersRaw] = await Promise.all([
    onlyChainId ? db(`chains/${onlyChainId}`).then((c) => (c && 'price' in c ? [{ id: onlyChainId, ...c }] : [])) : recentChains(RECENT_CHAINS),
    db('pkclub/members'),
  ]);
  const members = cleanMembers(membersRaw);
  for (const c of chains) {
    const keys = myEntryKeys(c, uid);
    const member = memberOf(uid, chainDay(c), members);
    if (keys.length) {
      const removed = keys.map((k) => c.entries[k]);
      await db(`chains/${c.id}/entries`, { method: 'PATCH', body: Object.fromEntries(keys.map((k) => [k, null])) });
      const detail = removed.map((e) => `${e.court}號場 ${headsOf(e)} 人`).join('、');
      return { c, members, text: `已取消 ${c.date} ${c.title} 的報名（${detail}）` };
    }
    if (member && !c.leaves?.[member.key]) {
      await db(`chains/${c.id}/leaves/${member.key}`, { method: 'PUT', body: true });
      return { c, members, text: `已登記 ${c.date} ${c.title} 請假，${member.court}號場會員名額釋出給單次接龍` };
    }
    if (member && onlyChainId) return { c, members, text: `你 ${c.date} 已經請假了`, noChange: true };
  }
  return null;
}

// 文字用 textV2 + mention，讓大家知道是誰取消的
function mentionText(uid, text) {
  return { type: 'textV2', text: `{me} ${text}`, substitution: { me: { type: 'mention', mentionee: { type: 'user', userId: uid } } } };
}

async function handleCancel(event, onlyChainId) {
  const uid = event.source?.userId;
  if (!uid) return;
  try {
    const result = await cancelFor(uid, onlyChainId);
    if (!result) {
      await reply(event.replyToken, [mentionText(uid, '你目前沒有報名最近的場次，不需要取消 🙂')]);
      return;
    }
    // 重新讀一次，名單卡顯示取消後的最新狀態（候補自動遞補）
    const fresh = result.noChange ? result.c : { id: result.c.id, ...(await db(`chains/${result.c.id}`)) };
    await reply(event.replyToken, [mentionText(uid, `${result.noChange ? '' : '✅ '}${result.text}`), buildChainFlex(fresh, result.members)]);
  } catch (err) {
    console.error('取消報名失敗', err);
    await reply(event.replyToken, [mentionText(uid, '取消失敗，請稍後再試，或點名單卡上的「我要報名 / 修改」進報名頁取消')]);
  }
}

// ---------- LINE ----------
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

// ---------- 歡迎卡片 ----------
// 橫幅圖放在報名網站（GitHub Pages）：新 logo + 背景的鹿，20:13
const WELCOME_HERO = 'https://charliersa.github.io/pickleball-attack/assets/welcome-hero.jpg';
const W = { bg: '#0b1a3a', panel: '#13254d', gold: '#FFC83D', orange: '#FF9A1F', text: '#EEF2FF', muted: '#AAB6D3' };

const featureRow = (icon, text) => ({
  type: 'box', layout: 'baseline', spacing: 'md',
  contents: [
    { type: 'text', text: icon, size: 'sm', flex: 0 },
    { type: 'text', text, size: 'sm', color: W.text, wrap: true, flex: 1 },
  ],
});

function welcomeFlex(chains) {
  const buttons = chains.length
    ? chains.map((c, i) => ({
      type: 'button', style: 'primary', height: 'sm', color: i === 0 ? W.orange : '#C77A12',
      action: { type: 'uri', label: `立即報名｜${c.date}`.slice(0, 40), uri: chainUrl(c.id) },
    }))
    : [{ type: 'button', style: 'primary', height: 'sm', color: W.orange, action: { type: 'uri', label: '打開報名網站', uri: LIFF_URL } }];
  const sessions = chains.map((c) => ({
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: '📅', size: 'sm', flex: 0 },
      { type: 'text', text: `${c.date}　${c.title}`, size: 'sm', color: W.gold, weight: 'bold', wrap: true, flex: 1 },
    ],
  }));
  return {
    type: 'flex',
    altText: '👋 歡迎加入進擊的匹克團！點卡片按鈕直接報名',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image', url: WELCOME_HERO, size: 'full', aspectRatio: '20:13', aspectMode: 'cover',
        action: { type: 'uri', uri: chains[0] ? chainUrl(chains[0].id) : LIFF_URL },
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', backgroundColor: W.bg, paddingAll: '18px',
        contents: [
          { type: 'text', text: 'WELCOME', size: 'xs', color: W.orange, weight: 'bold' },
          { type: 'text', text: '歡迎加入進擊的匹克團！', size: 'lg', color: W.gold, weight: 'bold', wrap: true },
          { type: 'text', text: '週五・週日雙時段｜鹿角 4、5 號場分級包場', size: 'xs', color: W.muted, wrap: true },
          { type: 'separator', color: '#2a3d6b', margin: 'md' },
          {
            type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md',
            contents: [
              featureRow('🌱', '初學友善、同級交流、跨級挑戰，依程度分場'),
              featureRow('💰', '1～2 月體驗期單次 160 元／人，3 月起推出會員方案'),
              featureRow('⏳', '額滿自動排候補，有人取消就遞補'),
            ],
          },
          ...(sessions.length ? [{
            type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', paddingAll: '12px',
            backgroundColor: W.panel, cornerRadius: '10px', contents: sessions,
          }] : []),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: W.bg, paddingAll: '14px', paddingTop: '0px',
        contents: [
          ...buttons,
          { type: 'text', text: '💬 要取消報名，在群組輸入「取消報名」', size: 'xxs', color: W.muted, align: 'center', margin: 'md', wrap: true },
        ],
      },
    },
  };
}

// 歡迎訊息：先一則 textV2 用 {m0}、{m1}… @ 每位新成員（Flex 卡片不能 @ 人），再接歡迎卡片
async function welcomeMessages(members) {
  const users = members.filter((m) => m.type === 'user').slice(0, 20);
  if (!users.length) return null;
  const substitution = {};
  users.forEach((m, i) => {
    substitution[`m${i}`] = { type: 'mention', mentionee: { type: 'user', userId: m.userId } };
  });
  const names = users.map((_, i) => `{m${i}}`).join(' ');
  const chains = await upcomingChains();
  return [
    { type: 'textV2', text: `👋 歡迎 ${names} 加入！報名請點下面卡片的按鈕 👇`, substitution },
    welcomeFlex(chains),
  ];
}

async function handleEvent(event) {
  if (event.type === 'memberJoined') {
    const msgs = await welcomeMessages(event.joined?.members || []);
    if (msgs) await reply(event.replyToken, msgs);
  } else if (event.type === 'join') {
    await reply(event.replyToken, [{
      type: 'text',
      text: `大家好，我是匹克球小幫手 🏓\n有新朋友加入時我會打招呼；輸入「取消報名」可以直接取消最新一場的報名。\n\n發起接龍請點：\n${LIFF_URL}`,
    }]);
  } else if (event.type === 'message' && event.message?.type === 'text' && CANCEL_WORDS.includes(event.message.text.trim())) {
    await handleCancel(event);
  } else if (event.type === 'postback') {
    const p = new URLSearchParams(event.postback?.data || '');
    if (p.get('a') === 'cancel' && p.get('e')) await handleCancel(event, p.get('e'));
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
