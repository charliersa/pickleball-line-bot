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
// 改版前的接龍（沒有 courts 欄位）：週日 6 號挑戰場、7 號交流場；舊會員資料 6→4、7→5
const LEGACY_COURTS = { 6: { name: '進擊挑戰場', level: '3.0+' }, 7: { name: '進擊交流場', level: '2.5～2.99' } };
const LEGACY_COURT_MAP = { 6: '4', 7: '5' };

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
    .filter((c) => c && 'price' in c)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

// 報名系統的接龍網址要帶 ?e=<chainId> 才會直接打開報名頁
async function latestSignupLink() {
  try {
    const [c] = await recentChains(1);
    return c ? chainUrl(c.id) : LIFF_URL;
  } catch (err) {
    console.error('查詢最新接龍失敗', err);
    return LIFF_URL;
  }
}

// ---------- 跟網站相同的名額邏輯（index.js） ----------
function normalizeMember(key, m) {
  if (!m || !PLANS.includes(m.plan) || !/^\d{1,2}$/.test(String(m.court))) return null;
  const legacy = !key.includes('_');
  const day = DAY_LABEL[m.day] ? m.day : (key.endsWith('_fri') ? 'fri' : 'sun');
  const rawCourt = String(m.court);
  return {
    key,
    lineId: key.split('_')[0],
    name: String(m.name || '會員'),
    plan: m.plan,
    day,
    rawCourt,
    court: legacy && !m.day ? (LEGACY_COURT_MAP[rawCourt] || rawCourt) : rawCourt,
  };
}

function cleanMembers(val) {
  return Object.entries(val || {}).map(([k, m]) => normalizeMember(k, m)).filter(Boolean);
}

const chainDay = (c) => (DAY_LABEL[c.day] ? c.day : 'sun');

function memberOf(uid, day, members) {
  return members.find((m) => m.key === `${uid}_${day}`) || (day === 'sun' && members.find((m) => m.key === uid && m.day === 'sun')) || null;
}

function chainCourts(c) {
  const src = c.courts || LEGACY_COURTS;
  return Object.keys(src).sort((a, b) => a - b).map((no) => ({ no, name: src[no].name, level: src[no].level }));
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
  const ms = members.filter((m) => m.day === day && (m.court === court.no || m.rawCourt === court.no))
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
const myEntryKeys = (c, uid) => Object.keys(c.entries || {}).filter((k) => k === uid || k.startsWith(`${uid}_`));

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

// 歡迎訊息：用 textV2 的 {m0}、{m1}… 佔位符 @ 每位新成員
async function welcomeMessage(members) {
  const users = members.filter((m) => m.type === 'user').slice(0, 20);
  if (!users.length) return null;
  const substitution = {};
  users.forEach((m, i) => {
    substitution[`m${i}`] = { type: 'mention', mentionee: { type: 'user', userId: m.userId } };
  });
  const names = users.map((_, i) => `{m${i}}`).join(' ');
  const link = await latestSignupLink();
  return {
    type: 'textV2',
    text: `👋 歡迎 ${names} 加入！\n\n🏓 進擊的匹克團｜週五、週日雙時段分級包場\n1～2 月體驗期單次只要 160 元／人，3 月起正式推出會員方案！\n\n📣 報名打球請點連結，或點群組裡最新的接龍卡片「我要報名」，額滿會自動排候補：\n${link}\n\n❌ 要取消報名，在群組輸入「取消報名」即可`,
    substitution,
  };
}

async function handleEvent(event) {
  if (event.type === 'memberJoined') {
    const msg = await welcomeMessage(event.joined?.members || []);
    if (msg) await reply(event.replyToken, [msg]);
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
