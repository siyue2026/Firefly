import { authCheck } from "../_auth.js"
import { isValidSlug, mergePostMeta, sanitizePostMetaUpdates } from "../_util.js"

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  const { results } = await env.DB.prepare("SELECT id, title, slug, status, created_at FROM posts WHERE status != 'deleted' ORDER BY created_at DESC, id DESC").all()
  return Response.json(results)
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
