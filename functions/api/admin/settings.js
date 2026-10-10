import { authCheck } from "./_auth.js"

// 站点内容设置（相册 / 留言板 / 音乐 / 动态 / 背景图片）读写接口。
// GET  → 返回 { gallery, guestbook, music, dynamic, background }（未设置的为 null）
// PUT  → body: { key: "gallery" | "guestbook" | "music" | "dynamic" | "background", value: {...} } 覆盖保存指定设置

const ALLOWED_KEYS = ["gallery", "guestbook", "music", "dynamic", "background"]
const ALBUM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const DYN_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/
const MUSIC_SERVERS = ["netease", "tencent", "kugou", "xiami", "baidu"]
const MUSIC_TYPES = ["song", "playlist", "album", "search", "artist"]
const MAX_VALUE_BYTES = 900_000

function str(v, max = 2000) {
  return typeof v === "string" ? v.slice(0, max) : ""
}

function validateGallery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "gallery 必须是对象" }
  }
  const { albums, columnWidth, photoUrls } = value
  if (!Array.isArray(albums)) return { error: "albums 必须是数组" }
  if (albums.length > 100) return { error: "相册数量过多（最多 100 个）" }

  const out = { albums: [], columnWidth: 240, photoUrls: {} }
  const seenIds = new Set()

  for (const raw of albums) {
    if (!raw || typeof raw !== "object") return { error: "相册条目必须是对象" }
    const id = str(raw.id, 64)
    if (!ALBUM_ID_RE.test(id)) {
      return { error: `相册 ID 不合法（仅限字母、数字、-、_）：${id || "(空)"}` }
    }
    if (seenIds.has(id)) return { error: `相册 ID 重复：${id}` }
    seenIds.add(id)

    const name = str(raw.name, 200).trim()
    if (!name) return { error: `相册 ${id} 缺少名称` }

    const album = { id, name }
    const description = str(raw.description, 2000)
    if (description) album.description = description
    const location = str(raw.location, 200)
    if (location) album.location = location
    const date = str(raw.date, 40)
    if (date) album.date = date
    if (Array.isArray(raw.tags)) {
      const tags = raw.tags.map((t) => str(t, 50).trim()).filter(Boolean).slice(0, 30)
      if (tags.length) album.tags = tags
    }
    const cover = str(raw.cover, 2000)
    if (cover) album.cover = cover
    const password = str(raw.password, 200)
    if (password) album.password = password
    const passwordHint = str(raw.passwordHint, 500)
    if (passwordHint) album.passwordHint = passwordHint

    out.albums.push(album)
  }

  const cw = Number(columnWidth)
  if (Number.isFinite(cw)) {
    out.columnWidth = Math.min(1000, Math.max(80, Math.round(cw)))
  }

  if (photoUrls && typeof photoUrls === "object" && !Array.isArray(photoUrls)) {
    for (const [id, urls] of Object.entries(photoUrls)) {
      if (!ALBUM_ID_RE.test(id)) continue
      if (!Array.isArray(urls)) continue
      const clean = urls
        .map((u) => str(u, 2048).replace(/[\r\n\t]/g, "").trim())
        .filter(Boolean)
        .slice(0, 500)
      out.photoUrls[id] = clean
    }
  }

  return { value: out }
}

function validateGuestbook(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "guestbook 必须是对象" }
  }
  const content = typeof value.content === "string" ? value.content : ""
  if (content.length > 200_000) return { error: "留言板内容过长（最多 200000 字符）" }
  return {
    value: {
      title: str(value.title, 200).trim(),
      description: str(value.description, 2000).trim(),
      content,
    },
  }
}

function validateMusic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "music 必须是对象" }
  }
  const out = {
    showInNavbar: value.showInNavbar !== false,
    showInSidebar: value.showInSidebar !== false,
    mode: value.mode === "meting" ? "meting" : "local",
    volume: 0.7,
    playMode: ["list", "one", "random"].includes(value.playMode) ? value.playMode : "list",
    showLyrics: value.showLyrics === true,
    meting: {},
    local: { playlist: [] },
  }
  const volume = Number(value.volume)
  if (Number.isFinite(volume)) {
    out.volume = Math.min(1, Math.max(0, Math.round(volume * 100) / 100))
  }

  const meting = value.meting && typeof value.meting === "object" && !Array.isArray(value.meting) ? value.meting : {}
  out.meting = {
    api: str(meting.api, 2000).trim() || "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
    server: MUSIC_SERVERS.includes(meting.server) ? meting.server : "netease",
    type: MUSIC_TYPES.includes(meting.type) ? meting.type : "playlist",
    id: str(meting.id, 200).trim(),
    auth: str(meting.auth, 500),
    fallbackApis: Array.isArray(meting.fallbackApis)
      ? meting.fallbackApis.map((u) => str(u, 2000).trim()).filter(Boolean).slice(0, 10)
      : [],
  }

  const playlist = value.local && typeof value.local === "object" && Array.isArray(value.local.playlist)
    ? value.local.playlist
    : []
  if (playlist.length > 200) return { error: "歌曲数量过多（最多 200 首）" }
  for (const raw of playlist) {
    if (!raw || typeof raw !== "object") return { error: "歌曲条目必须是对象" }
    const name = str(raw.name, 200).trim()
    const url = str(raw.url, 2000).trim()
    if (!name || !url) return { error: "每首歌都需要填写名称和音频地址" }
    out.local.playlist.push({
      name,
      artist: str(raw.artist, 200).trim(),
      url,
      cover: str(raw.cover, 2000).trim(),
      lrc: typeof raw.lrc === "string" ? raw.lrc.slice(0, 200_000) : "",
    })
  }

  return { value: out }
}

function validateDynamic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "dynamic 必须是对象" }
  }
  const { items } = value
  if (!Array.isArray(items)) return { error: "items 必须是数组" }
  if (items.length > 500) return { error: "动态数量过多（最多 500 条）" }

  const out = { items: [] }
  const seenIds = new Set()
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return { error: "动态条目必须是对象" }
    const id = str(raw.id, 64)
    if (!ALBUM_ID_RE.test(id)) return { error: `动态 ID 不合法：${id || "(空)"}` }
    if (seenIds.has(id)) return { error: `动态 ID 重复：${id}` }
    seenIds.add(id)

    const published = str(raw.published, 40).trim()
    if (published && !DYN_DATE_RE.test(published)) {
      return { error: `动态时间格式不正确（应为 YYYY-MM-DD HH:mm:ss）：${published}` }
    }
    const content = typeof raw.content === "string" ? raw.content : ""
    if (content.length > 20_000) return { error: "动态内容过长（最多 20000 字符）" }

    const item = { id, published, content }
    const location = str(raw.location, 100).trim()
    if (location) item.location = location
    if (raw.pinned === true) item.pinned = true
    if (raw.deleted === true) item.deleted = true
    out.items.push(item)
  }

  return { value: out }
}

function validateBackground(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "background 必须是对象" }
  }
  const cleanList = (arr, label) => {
    if (arr === undefined || arr === null) return []
    if (!Array.isArray(arr)) {
      return { error: `${label}必须是数组` }
    }
    const clean = arr
      .map((u) => str(u, 2048).replace(/[\r\n\t]/g, "").trim())
      .filter(Boolean)
      .slice(0, 30)
    return clean
  }
  const desktop = cleanList(value.desktop, "桌面端图片列表")
  if (desktop.error) return desktop
  const mobile = cleanList(value.mobile, "移动端图片列表")
  if (mobile.error) return mobile
  if (desktop.length === 0 && mobile.length === 0) {
    return { error: "桌面端和移动端背景图片不能同时为空" }
  }
  return { value: { desktop, mobile } }
}

const VALIDATORS = {
  gallery: validateGallery,
  guestbook: validateGuestbook,
  music: validateMusic,
  dynamic: validateDynamic,
  background: validateBackground,
}

const SAVED_MESSAGES = {
  gallery: "相册设置已保存",
  guestbook: "留言板设置已保存",
  music: "音乐设置已保存",
  dynamic: "动态设置已保存",
  background: "背景图片设置已保存",
}

export async function onRequestGet(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  const settings = { gallery: null, guestbook: null, music: null, dynamic: null, background: null }
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all()
    for (const row of results) {
      if (!ALLOWED_KEYS.includes(row.key)) continue
      try {
        settings[row.key] = JSON.parse(row.value)
      } catch {
        // 忽略损坏的数据
      }
    }
  } catch {
    // settings 表尚未创建时返回空设置
  }
  return Response.json(settings)
}

export async function onRequestPut(context) {
  const { request, env } = context
  const authFail = await authCheck(request, env)
  if (authFail) return authFail

  let body
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ success: false, message: "请求体不是合法 JSON" }), { status: 400 })
  }

  const key = body && body.key
  if (!ALLOWED_KEYS.includes(key)) {
    return new Response(JSON.stringify({ success: false, message: "key 仅支持 gallery、guestbook、music、dynamic、background" }), { status: 400 })
  }

  const { value, error } = VALIDATORS[key](body.value)
  if (error) {
    return new Response(JSON.stringify({ success: false, message: error }), { status: 400 })
  }

  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_VALUE_BYTES) {
    return new Response(JSON.stringify({ success: false, message: "设置数据过大" }), { status: 400 })
  }

  await env.DB.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, serialized).run()

  return Response.json({ success: true, message: SAVED_MESSAGES[key] })
}
