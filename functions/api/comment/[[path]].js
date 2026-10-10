// 博客评论区后端（Waline v3 协议兼容实现，运行在 Pages Functions + D1 上）
// 背景：前端使用 @waline/client，原先指向的 serverURL 为占位地址无法访问。
// 这里实现客户端（@waline/client 3.x）实际用到的接口子集，返回格式与官方一致：
//   GET  /api/comment?path=..&page=..&pageSize=..&sortBy=..   评论列表（含回复 children）
//   GET  /api/comment?type=count&url=a,b                      评论数统计（数组，按 url 顺序）
//   GET  /api/comment?type=recent&count=n                     最新评论
//   POST /api/comment                                         发表评论 / 回复（body 为 comment 对象）
//   PUT  /api/comment/:id                                     点赞（body: { like: true|false }）
// 安全说明：评论内容经服务端 Markdown 渲染 + HTML 转义（先转义再生成受控标签），
// 仅放行客户端提交的表情 <img class="wl-emoji" ...> 标签。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const STATUS_FILTER = "status NOT IN ('waiting', 'spam')";
const MAX_COMMENT_LEN = 20000;
const IP_QPS_SECONDS = 60; // 同一 IP 两次评论最小间隔（秒）

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}

const ok = (data) => json({ errno: 0, errmsg: "", data });
const fail = (msg) => json({ errno: 1, errmsg: msg, data: "" });

// ---------- 工具函数 ----------

function toId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getIP(request) {
  const direct = request.headers.get("CF-Connecting-IP");
  if (direct) return direct.trim();
  const xff = request.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim();
}

async function countRows(env, sql, params) {
  const row = await env.DB.prepare(sql).bind(...params).first("n");
  return Number(row) || 0;
}

// ---------- Markdown 渲染（先转义，再生成受控标签，杜绝 XSS） ----------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderMarkdown(raw) {
  const stash = [];
  const put = (html) => `\uE000${stash.push(html) - 1}\uE001`;

  let s = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // 1. 放行客户端提交的表情图片（格式与 @waline/client 一致），其余 HTML 一律转义
  s = s.replace(
    /<img class="wl-emoji" src="(https?:\/\/[^"<>]+)"(?: alt="([^"<>]*)")?>/g,
    (m, src, alt) => put(`<img class="wl-emoji" src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}">`),
  );
  s = escapeHtml(s);

  // 2. 行内代码
  s = s.replace(/`([^`\n]+)`/g, (m, code) => put(`<code>${code}</code>`));

  // 3. Markdown 链接（仅 http/https/mailto）
  s = s.replace(
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g,
    (m, text, href) => put(`<a href="${href}" target="_blank" rel="noopener nofollow ugc">${text}</a>`),
  );

  // 4. 裸链接自动识别
  s = s.replace(/https?:\/\/[^\s<>"'\uE000\uE001]+/g, (m) => {
    const url = m.replace(/[.,;:!?，。；：！？、]+$/u, "");
    const tail = m.slice(url.length);
    return put(`<a href="${url}" target="_blank" rel="noopener nofollow ugc">${url}</a>`) + tail;
  });

  // 5. 加粗 / 删除线 / 斜体
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");

  // 6. 换行
  s = s.replace(/\n/g, "<br>");

  // 7. 还原占位内容
  s = s.replace(/\uE000(\d+)\uE001/g, (m, i) => stash[Number(i)] || "");
  return s;
}

// ---------- 头像（与官方默认策略类似：QQ 号走 QQ 头像，其余用邮箱哈希） ----------

const QQ_LOGO = (qq) => `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`;

function avatarFor(nick, mail) {
  const n = String(nick || "").trim();
  const m = String(mail || "").trim().toLowerCase();
  if (/^\d+$/.test(n)) return QQ_LOGO(n);
  const qqMail = m.match(/^(\d+)@qq\.com$/);
  if (qqMail) return QQ_LOGO(qqMail[1]);
  if (!m) return "";
  return `https://cravatar.cn/avatar/${md5(m)}?d=mp&s=100`;
}

// ---------- MD5（Web Crypto 不支持 MD5，这里内嵌纯 JS 实现，仅用于邮箱哈希） ----------

function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  const total = (((bytes.length + 8) >> 6) + 1) << 6;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((bytes.length * 8) / 4294967296), true);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < total; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const hex = (n) => {
    let out = "";
    for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    return out;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// ---------- 浏览器 / 系统信息解析（用于评论卡片展示） ----------

const ver2 = (v) => String(v).split(".").slice(0, 2).join(".");

function parseUA(ua) {
  const u = String(ua || "");
  let m;
  let browser = "";
  if ((m = u.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) browser = `Edge${ver2(m[1])}`;
  else if ((m = u.match(/(?:OPR|Opera)\/([\d.]+)/))) browser = `Opera${ver2(m[1])}`;
  else if ((m = u.match(/Firefox\/([\d.]+)/))) browser = `Firefox${ver2(m[1])}`;
  else if ((m = u.match(/Chrome\/([\d.]+)/))) browser = `Chrome${ver2(m[1])}`;
  else if ((m = u.match(/Version\/([\d.]+).*Safari\//))) browser = `Safari${ver2(m[1])}`;

  let os = "";
  const winMap = { "10.0": "10", "11.0": "11", "6.3": "8.1", "6.2": "8", "6.1": "7" };
  if ((m = u.match(/Windows NT ([\d.]+)/))) os = `Windows ${winMap[m[1]] || m[1]}`;
  else if ((m = u.match(/Android ([\d.]+)/))) os = `Android ${m[1]}`;
  else if ((m = u.match(/(?:iPhone|iPad|iPod).* OS ([\d_]+)/))) os = `iOS ${m[1].replaceAll("_", ".")}`;
  else if ((m = u.match(/Mac OS X ([\d_]+)/))) os = `Mac OS X ${m[1].replaceAll("_", ".")}`;
  else if (/Linux/.test(u)) os = "Linux";

  return { browser, os };
}

// ---------- 评论格式化（字段与官方服务端保持一致） ----------

function formatComment(row) {
  const { browser, os } = parseUA(row.ua);
  const item = {
    objectId: row.object_id,
    url: row.url,
    nick: row.nick,
    link: row.link || "",
    comment: renderMarkdown(row.comment),
    like: Number(row.like_count) || 0,
    status: row.status,
    sticky: !!row.sticky,
    time: Date.parse(row.inserted_at),
    avatar: avatarFor(row.nick, row.mail),
  };
  if (browser) item.browser = browser;
  if (os) item.os = os;
  // 根评论不能带 rid/pid 字段：客户端用 "'rid' in comment" 判断是否为回复
  if (row.pid != null) item.pid = row.pid;
  if (row.rid != null) item.rid = row.rid;
  return item;
}

// ---------- 各接口实现 ----------

async function getList(url, env) {
  const path = (url.searchParams.get("path") || "").trim();
  if (!path) return fail("缺少 path 参数");

  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "10", 10) || 10));
  const sortBy = url.searchParams.get("sortBy") || "insertedAt_desc";
  const SORTS = {
    insertedAt_desc: "inserted_at DESC, object_id DESC",
    insertedAt_asc: "inserted_at ASC, object_id ASC",
    like_desc: "like_count DESC, object_id DESC",
  };
  const orderBy = SORTS[sortBy];
  if (!orderBy) return fail("sortBy 参数不合法");

  const total = await countRows(env,
    `SELECT COUNT(*) AS n FROM wl_comments WHERE url = ? AND ${STATUS_FILTER}`, [path]);
  const rootTotal = await countRows(env,
    `SELECT COUNT(*) AS n FROM wl_comments WHERE url = ? AND rid IS NULL AND ${STATUS_FILTER}`, [path]);

  const roots = (await env.DB.prepare(
    `SELECT * FROM wl_comments
     WHERE url = ? AND rid IS NULL AND ${STATUS_FILTER}
     ORDER BY sticky DESC, ${orderBy}
     LIMIT ? OFFSET ?`,
  ).bind(path, pageSize, (page - 1) * pageSize).all()).results || [];

  let children = [];
  if (roots.length) {
    const ids = roots.map((r) => r.object_id);
    const ph = ids.map(() => "?").join(",");
    children = (await env.DB.prepare(
      `SELECT * FROM wl_comments
       WHERE url = ? AND rid IN (${ph}) AND ${STATUS_FILTER}
       ORDER BY inserted_at ASC`,
    ).bind(path, ...ids).all()).results || [];
  }

  const data = roots.map((root) => {
    const item = formatComment(root);
    const kids = children.filter((c) => c.rid === root.object_id).map(formatComment);
    item.children = kids;
    const map = new Map([[item.objectId, item], ...kids.map((c) => [c.objectId, c])]);
    for (const kid of kids) {
      const parent = kid.pid != null ? map.get(kid.pid) : undefined;
      if (parent) kid.reply_user = { nick: parent.nick, link: parent.link, avatar: parent.avatar };
    }
    return item;
  });

  return ok({
    page,
    totalPages: Math.ceil(rootTotal / pageSize),
    pageSize,
    count: total,
    data,
  });
}

async function getCount(url, env) {
  const urls = (url.searchParams.get("url") || "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!urls.length) return ok([]);
  const ph = urls.map(() => "?").join(",");
  const rows = (await env.DB.prepare(
    `SELECT url, COUNT(*) AS n FROM wl_comments WHERE url IN (${ph}) AND ${STATUS_FILTER} GROUP BY url`,
  ).bind(...urls).all()).results || [];
  const map = new Map(rows.map((r) => [r.url, Number(r.n) || 0]));
  return ok(urls.map((u) => map.get(u) ?? 0));
}

async function getRecent(url, env) {
  const count = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("count") || "10", 10) || 10));
  const rows = (await env.DB.prepare(
    `SELECT * FROM wl_comments WHERE ${STATUS_FILTER} ORDER BY inserted_at DESC LIMIT ?`,
  ).bind(count).all()).results || [];
  return ok(rows.map(formatComment));
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("请求体不是合法 JSON");
  }
  if (!body || typeof body !== "object") return fail("请求体不合法");

  const urlPath = typeof body.url === "string" ? body.url.trim().slice(0, 500) : "";
  if (!urlPath) return fail("缺少 url 参数");
  const rawComment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!rawComment) return fail("评论内容不能为空");
  if (rawComment.length > MAX_COMMENT_LEN) return fail("评论内容过长");

  const nick = (typeof body.nick === "string" ? body.nick.trim() : "").slice(0, 100) || "匿名";
  const mail = (typeof body.mail === "string" ? body.mail.trim() : "").slice(0, 200);
  const link = (typeof body.link === "string" ? body.link.trim() : "").slice(0, 500);
  const ua = (typeof body.ua === "string" ? body.ua : "").slice(0, 1000);
  const pid = toId(body.pid);
  const rid = toId(body.rid);

  const ip = getIP(request);

  // 防重复：完全相同的内容不允许重复提交（先于限流检查，与官方行为一致，双击提交时提示更准确）
  const dup = await countRows(env,
    "SELECT COUNT(*) AS n FROM wl_comments WHERE url = ? AND nick = ? AND mail = ? AND link = ? AND comment = ?",
    [urlPath, nick, mail, link, rawComment]);
  if (dup > 0) return fail("请勿重复提交相同内容");

  // 防刷：同一 IP 两次评论的间隔限制
  if (ip) {
    const recent = await countRows(env,
      "SELECT COUNT(*) AS n FROM wl_comments WHERE ip = ? AND inserted_at > ?",
      [ip, new Date(Date.now() - IP_QPS_SECONDS * 1000).toISOString()]);
    if (recent > 0) return fail("评论提交太快了，请稍后再试");
  }

  const insertedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO wl_comments (url, nick, mail, link, comment, ua, ip, pid, rid, like_count, status, sticky, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'approved', 0, ?)`,
  ).bind(urlPath, nick, mail, link, rawComment, ua, ip, pid, rid, insertedAt).run();

  const id = result.meta && result.meta.last_row_id;
  const row = await env.DB.prepare("SELECT * FROM wl_comments WHERE object_id = ?").bind(id).first();
  if (!row) return fail("评论保存失败，请稍后再试");
  return ok(formatComment(row));
}

async function handlePut(request, env, idPart) {
  const objectId = toId(idPart);
  if (!objectId) return fail("参数不合法");
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("请求体不是合法 JSON");
  }
  if (!body || typeof body.like !== "boolean") return fail("仅支持点赞操作");

  await env.DB.prepare(
    "UPDATE wl_comments SET like_count = MAX(like_count + ?, 0) WHERE object_id = ?",
  ).bind(body.like ? 1 : -1, objectId).run();

  const row = await env.DB.prepare("SELECT * FROM wl_comments WHERE object_id = ?").bind(objectId).first();
  if (!row) return fail("评论不存在");
  return ok(formatComment(row));
}

// ---------- 入口 ----------

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  try {
    const idPart = ((url.pathname.match(/^\/api\/comment\/?(.*)$/) || [])[1] || "").replace(/\/+$/, "");

    switch (request.method) {
      case "GET":
        if (url.searchParams.get("type") === "count") return await getCount(url, env);
        if (url.searchParams.get("type") === "recent") return await getRecent(url, env);
        return await getList(url, env);
      case "POST":
        return await handlePost(request, env);
      case "PUT":
        return await handlePut(request, env, idPart);
      case "DELETE":
        return fail("暂不支持删除评论");
      default:
        return json({ errno: 1, errmsg: "Method Not Allowed", data: "" }, 405);
    }
  } catch (error) {
    console.error("[comment] error:", error && error.stack ? error.stack : error);
    return fail("服务器开小差了，请稍后再试");
  }
}
