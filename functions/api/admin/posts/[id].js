import { authCheck } from "../_auth.js"
import { isValidSlug, mergePostMeta, sanitizePostMetaUpdates } from "../_util.js"

export async function onRequestGet(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})
  
  const { results } = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).all()
  if(results.length === 0) return new Response("文章不存在", {status:404})
  return Response.json(results[0])
}

export async function onRequestPut(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})

  const { slug, title, excerpt = "", content, status, meta } = await request.json()
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

  const existing = await env.DB.prepare("SELECT id, status, meta FROM posts WHERE id = ?").bind(postId).first()
  if (!existing) return new Response("文章不存在", {status: 404})

  const clash = await env.DB.prepare("SELECT id FROM posts WHERE slug = ? AND id != ?").bind(slug, postId).first()
  if (clash) {
    return new Response(JSON.stringify({success: false, message: "slug 已被其他文章使用"}), {status: 409})
  }

  // 未传 status 时保留原状态（避免编辑草稿时被误发布）
  let nextStatus = existing.status
  if (status === "draft" || status === "published") nextStatus = status
  if (nextStatus === "deleted") nextStatus = "published"

  // 未传 meta 时保留原 meta；其余 meta 键（tags 等）在写入时原样保留
  const metaJson = updates ? mergePostMeta(existing.meta, updates) : (existing.meta || "{}")

  await env.DB.prepare(`
    UPDATE posts SET slug=?, title=?, excerpt=?, content=?, status=?, meta=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(slug, title, excerpt, content, nextStatus, metaJson, postId).run()

  return Response.json({success: true, message: "文章更新成功"})
}

export async function onRequestDelete(context) {
  const { request, env, params } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail
  const postId = Number(params.id)
  if(!postId) return new Response("文章ID非法", {status:400})

  // 软删除：保留记录，发布时用于从博客移除对应页面
  await env.DB.prepare("UPDATE posts SET status='deleted', updated_at=CURRENT_TIMESTAMP WHERE id = ?").bind(postId).run()
  return Response.json({success: true, message: "文章已删除，发布后从博客移除"})
}
