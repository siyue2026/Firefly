import { authCheck } from "./_auth.js"
import { isValidSlug } from "./_util.js"

// 批量导入文章（已存在的 slug 跳过，不覆盖），供把本地 markdown 导入 D1
export async function onRequestPost(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  let body
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ success: false, message: "请求体不是合法 JSON" }), { status: 400 })
  }
  const posts = Array.isArray(body && body.posts) ? body.posts : []
  if (posts.length === 0) {
    return new Response(JSON.stringify({ success: false, message: "没有可导入的文章" }), { status: 400 })
  }

  let inserted = 0
  let skipped = 0
  const invalid = []
  for (const p of posts) {
    if (!p || !isValidSlug(p.slug) || !p.title || typeof p.content !== "string") {
      invalid.push((p && p.slug) || "(无slug)")
      continue
    }
    const now = new Date().toISOString()
    const res = await env.DB.prepare(`
      INSERT INTO posts (slug, title, excerpt, content, status, meta, file_path, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING
    `).bind(
      p.slug,
      p.title,
      p.excerpt || "",
      p.content,
      p.status === "draft" ? "draft" : "published",
      typeof p.meta === "string" ? p.meta : JSON.stringify(p.meta || {}),
      p.file_path || null,
      p.published_at || now,
      p.published_at || now,
      p.published_at || now
    ).run()
    if (res.meta && res.meta.changes > 0) inserted++
    else skipped++
  }
  return Response.json({ success: true, inserted, skipped, invalid })
}
