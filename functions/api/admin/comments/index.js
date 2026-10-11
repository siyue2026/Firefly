import { authCheck } from "../_auth.js"
import { buildCommentFilters, parseCommentQuery, toAdminComment } from "./_util.js"

// 评论管理（控制台）列表接口。
// GET /api/admin/comments?page=&pageSize=&status=all|approved|waiting|spam&search=&url=
//   → { total, page, pageSize, totalPages, stats, urls, comments }
// 与管理端其他接口不同：这里返回评论原始 Markdown（管理端自行转义展示），
// 且不套用前台 STATUS_FILTER，待审核 / 垃圾评论同样可见可管理。

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const url = new URL(request.url)
  const query = parseCommentQuery(url.searchParams)
  if (query.error) {
    return new Response(JSON.stringify({ success: false, message: query.error }), { status: 400 })
  }

  const filters = buildCommentFilters(query)
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wl_comments ${filters.whereSql}`,
  ).bind(...filters.params).first()
  const total = Number(totalRow && totalRow.n) || 0
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize))

  // 列表查询；reply_count 为该评论下的回复条数（用于删除确认提示）
  const { results } = await env.DB.prepare(
    `SELECT *, (SELECT COUNT(*) FROM wl_comments child WHERE child.rid = wl_comments.object_id) AS reply_count
     FROM wl_comments ${filters.whereSql}
     ORDER BY object_id DESC LIMIT ? OFFSET ?`,
  ).bind(...filters.params, query.pageSize, (query.page - 1) * query.pageSize).all()

  // 回复目标昵称（用于展示「回复 @xxx」）
  const pids = [...new Set(results.map((r) => r.pid).filter((v) => v != null))]
  const parentNicks = new Map()
  if (pids.length) {
    const ph = pids.map(() => "?").join(",")
    const { results: parents } = await env.DB.prepare(
      `SELECT object_id, nick FROM wl_comments WHERE object_id IN (${ph})`,
    ).bind(...pids).all()
    for (const p of parents) parentNicks.set(p.object_id, p.nick)
  }

  const comments = results.map((r) =>
    toAdminComment(r, { replyTo: r.pid != null ? (parentNicks.get(r.pid) ?? null) : null }),
  )

  // 状态统计（在 url / 搜索条件下统计，不受状态筛选影响，供筛选标签展示数量）
  const statFilters = buildCommentFilters({ status: "all", search: query.search, url: query.url })
  const { results: statRows } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM wl_comments ${statFilters.whereSql} GROUP BY status`,
  ).bind(...statFilters.params).all()
  const stats = { all: 0, approved: 0, waiting: 0, spam: 0 }
  for (const row of statRows) {
    const n = Number(row.n) || 0
    if (row.status === "approved") stats.approved = n
    else if (row.status === "waiting") stats.waiting = n
    else if (row.status === "spam") stats.spam = n
    stats.all += n
  }

  // 页面维度列表（供筛选下拉，最多 100 个）
  const { results: urlRows } = await env.DB.prepare(
    "SELECT url, COUNT(*) AS n FROM wl_comments GROUP BY url ORDER BY n DESC, url ASC LIMIT 100",
  ).all()

  return Response.json({
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages,
    stats,
    urls: urlRows.map((r) => ({ url: r.url, count: Number(r.n) || 0 })),
    comments,
  })
}
