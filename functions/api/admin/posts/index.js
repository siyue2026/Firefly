import { authCheck } from "../_auth.js"
import { isValidSlug, mergePostMeta, sanitizePostMetaUpdates } from "../_util.js"

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  // ?trash=1 返回回收站（软删除）文章列表，默认返回正常文章列表
  const trash = new URL(request.url).searchParams.get("trash") === "1"
  const sql = trash
    ? "SELECT id, title, slug, status, created_at, updated_at, meta FROM posts WHERE status = 'deleted' ORDER BY updated_at DESC, id DESC"
    : "SELECT id, title, slug, status, created_at, meta FROM posts WHERE status != 'deleted' ORDER BY created_at DESC, id DESC"
  const { results } = await env.DB.prepare(sql).all()
  return Response.json(results)
}

// 清空回收站：DELETE ?trash=1，永久删除所有软删除文章（status='deleted'）。
// 必须带 trash=1 参数，防止误删正常文章。
export async function onRequestDelete(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  if (new URL(request.url).searchParams.get("trash") !== "1") {
    return new Response(JSON.stringify({success: false, message: "缺少 trash=1 参数，已拒绝删除"}), {status: 400})
  }
  const r = await env.DB.prepare("DELETE FROM posts WHERE status = 'deleted'").run()
  const n = r.meta.changes || 0
  return Response.json({ success: true, deleted: n, message: "已清空回收站（共删除 " + n + " 篇文章）" })
}

export async function onRequestPost(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  const { slug, title, excerpt = "", content, status = "published", meta } = await request.json()
  if (!slug || !title || typeof content !== "string") {
    return new Response(JSON.stringify({success: false, message: "slug、title、content 均不能为空"}), {status: 400})
  }
  if (!isValidSlug(slug)) {
    return new Response(JSON.stringify({success: false, message: "slug 格式不合法"}), {status: 400})
  }
  const { updates, error } = sanitizePostMetaUpdates(meta)
  if (error) {
    return new Response(JSON.stringify({success: false, message: error}), {status: 400})
  }

  const existing = await env.DB.prepare("SELECT id, status, meta FROM posts WHERE slug = ?").bind(slug).first()
  if (existing && existing.status !== "deleted") {
    return new Response(JSON.stringify({success: false, message: "已存在相同 slug 的文章，请更换"}), {status: 409})
  }

  if (existing) {
    // 回收站中的旧文章：恢复并覆盖内容（保留原文件关联与其他 meta 键）
    const metaJson = mergePostMeta(existing.meta, updates)
    await env.DB.prepare(`
      UPDATE posts SET title=?, excerpt=?, content=?, status=?, meta=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(title, excerpt, content, status, metaJson, existing.id).run()
  } else {
    const metaJson = mergePostMeta(null, updates)
    await env.DB.prepare(`
      INSERT INTO posts (slug, title, excerpt, content, status, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(slug, title, excerpt, content, status, metaJson).run()
  }

  return Response.json({success: true, message: "文章新增成功"})
}
