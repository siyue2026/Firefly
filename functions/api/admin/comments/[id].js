import { authCheck } from "../_auth.js"
import { COMMENT_STATUSES, toAdminComment } from "./_util.js"

// 单条评论管理接口（控制台）。
// PUT    /api/admin/comments/:id  body: { status?, sticky? } 改状态 / 置顶
// DELETE /api/admin/comments/:id?cascade=1  删除评论；cascade=1 时同时删除其下回复

function parseId(value) {
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function fail(message, status) {
  return new Response(JSON.stringify({ success: false, message }), { status })
}

export async function onRequestPut(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const commentId = parseId(params.id)
  if (!commentId) return fail("评论 ID 非法", 400)

  let body
  try {
    body = await request.json()
  } catch {
    return fail("请求体不是合法 JSON", 400)
  }
  if (!body || typeof body !== "object") return fail("请求体不合法", 400)

  const sets = []
  const values = []
  if ("status" in body) {
    if (!COMMENT_STATUSES.includes(body.status)) {
      return fail("status 仅支持 approved、waiting、spam", 400)
    }
    sets.push("status = ?")
    values.push(body.status)
  }
  if ("sticky" in body) {
    if (typeof body.sticky !== "boolean") return fail("sticky 必须是布尔值", 400)
    sets.push("sticky = ?")
    values.push(body.sticky ? 1 : 0)
  }
  if (!sets.length) return fail("没有可更新的字段（status / sticky 至少传一个）", 400)

  const existing = await env.DB.prepare("SELECT object_id FROM wl_comments WHERE object_id = ?").bind(commentId).first()
  if (!existing) return fail("评论不存在", 404)

  await env.DB.prepare(`UPDATE wl_comments SET ${sets.join(", ")} WHERE object_id = ?`).bind(...values, commentId).run()

  const row = await env.DB.prepare("SELECT * FROM wl_comments WHERE object_id = ?").bind(commentId).first()
  return Response.json({ success: true, comment: toAdminComment(row) })
}

export async function onRequestDelete(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const commentId = parseId(params.id)
  if (!commentId) return fail("评论 ID 非法", 400)

  const existing = await env.DB.prepare("SELECT object_id FROM wl_comments WHERE object_id = ?").bind(commentId).first()
  if (!existing) return fail("评论不存在", 404)

  const cascade = ["1", "true"].includes(new URL(request.url).searchParams.get("cascade") || "")
  let deleted = 1
  if (cascade) {
    const res = await env.DB.prepare("DELETE FROM wl_comments WHERE rid = ?").bind(commentId).run()
    deleted += Number(res.meta && res.meta.changes) || 0
  }
  await env.DB.prepare("DELETE FROM wl_comments WHERE object_id = ?").bind(commentId).run()
  return Response.json({ success: true, deleted })
}
