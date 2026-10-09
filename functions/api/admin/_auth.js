export async function authCheck(request, env) {
  const reqToken = request.headers.get('Authorization')
  if(!reqToken || reqToken !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({success: false, message: "未授权访问"}), {status:401})
  }
  return null
}
