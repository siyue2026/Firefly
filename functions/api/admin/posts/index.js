import { authCheck } from "../_auth.js"

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  const { results } = await env.DB.prepare("SELECT id, title, slug, created_at FROM posts ORDER BY created_at DESC").all()
  return Response.json(results)
}

export async function onRequestPost(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if(authFail) return authFail

  const { slug, title, excerpt, content, status = "published" } = await request.json()
  await env.DB.prepare(`
    INSERT INTO posts (slug, title, excerpt, content, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(slug, title, excerpt, content, status).run()

  return Response.json({success: true, message: "文章新增成功"})
}
