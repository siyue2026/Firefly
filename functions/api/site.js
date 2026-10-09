export async function onRequestGet(context) {
  const { env } = context
  const { results: posts } = await env.DB.prepare("SELECT id, slug, title, excerpt, published_at FROM posts WHERE status = 'published' ORDER BY published_at DESC").all()
  return Response.json({
    siteName: "Two Stars的控制台",
    posts: posts
  })
}
