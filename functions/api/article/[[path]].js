// 文章计数器后端（Waline v3 协议兼容实现，用于文章访问量统计）
//   GET  /api/article?path=a,b&type=time        → data: [{ time }, ...]（按 path 顺序）
//   POST /api/article  { path, type: "time", action: "inc" | "desc" } → data: [{ time }]

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const paths = (url.searchParams.get("path") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
      if (!paths.length) return ok([]);
      const ph = paths.map(() => "?").join(",");
      const rows = (await env.DB.prepare(
        `SELECT url, time FROM wl_counters WHERE url IN (${ph})`,
      ).bind(...paths).all()).results || [];
      const map = new Map(rows.map((r) => [r.url, Number(r.time) || 0]));
      return ok(paths.map((p) => ({ time: map.get(p) ?? 0 })));
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return fail("请求体不是合法 JSON");
      }
      const path = typeof (body && body.path) === "string" ? body.path.trim().slice(0, 500) : "";
      if (!path) return fail("缺少 path 参数");
      const action = body && body.action === "desc" ? "desc" : "inc";

      if (action === "desc") {
        const r = await env.DB.prepare(
          "UPDATE wl_counters SET time = MAX(time - 1, 0) WHERE url = ?",
        ).bind(path).run();
        if (!r.meta || r.meta.changes === 0) {
          await env.DB.prepare("INSERT OR IGNORE INTO wl_counters (url, time) VALUES (?, 0)").bind(path).run();
        }
      } else {
        await env.DB.prepare(
          "INSERT INTO wl_counters (url, time) VALUES (?, 1) ON CONFLICT(url) DO UPDATE SET time = time + 1",
        ).bind(path).run();
      }

      const row = await env.DB.prepare("SELECT time FROM wl_counters WHERE url = ?").bind(path).first();
      return ok([{ time: Number(row && row.time) || 0 }]);
    }

    return json({ errno: 1, errmsg: "Method Not Allowed", data: "" }, 405);
  } catch (error) {
    console.error("[article] error:", error && error.stack ? error.stack : error);
    return fail("服务器开小差了，请稍后再试");
  }
}
