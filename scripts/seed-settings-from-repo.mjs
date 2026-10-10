/**
 * 一次性播种脚本：把仓库中现有的站点内容转换为 settings 数据：
 * - 相册：src/config/galleryConfig.ts + 各相册 urls.txt
 * - 留言板：src/content/spec/guestbook.md
 * - 音乐：src/config/musicConfig.ts
 * - 动态：src/content/dynamic/*.md
 * - 背景图片：src/config/backgroundWallpaperImages.ts
 *
 * 用法：
 *   node scripts/seed-settings-from-repo.mjs --out seed.json        # 输出 JSON 文件（供 sync --data 预览）
 *   ADMIN_TOKEN=xxx node scripts/seed-settings-from-repo.mjs --put  # 直接写入线上数据库
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const args = process.argv.slice(2);
const getOpt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const ROOT = process.cwd();
const SOURCE = (process.env.PUBLISH_SOURCE || "https://firefly-cv5.pages.dev").replace(/\/+$/, "");

// ---------- 解析 galleryConfig.ts ----------
const configPath = path.join(ROOT, "src/config/galleryConfig.ts");
const configSrc = fs.readFileSync(configPath, "utf8");
const match = configSrc.match(/export const galleryConfig[^=]*=\s*(\{[\s\S]*\})\s*;?\s*$/);
if (!match) {
	console.error("无法从 galleryConfig.ts 中提取配置对象");
	process.exit(1);
}
const galleryRaw = new Function(`return (${match[1]});`)();

const albums = (galleryRaw.albums || []).map((a) => {
	const album = { id: a.id, name: a.name };
	if (a.description) album.description = a.description;
	if (a.location) album.location = a.location;
	if (a.date) album.date = a.date;
	if (Array.isArray(a.tags) && a.tags.length) album.tags = a.tags;
	if (a.cover) album.cover = a.cover;
	if (a.password) album.password = a.password;
	if (a.passwordHint) album.passwordHint = a.passwordHint;
	return album;
});

// ---------- 读取各相册 urls.txt ----------
const photoUrls = {};
for (const album of albums) {
	const urlsFile = path.join(ROOT, "public", "gallery", album.id, "urls.txt");
	if (!fs.existsSync(urlsFile)) continue;
	photoUrls[album.id] = fs
		.readFileSync(urlsFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
}

const gallery = {
	albums,
	columnWidth: galleryRaw.columnWidth || 240,
	photoUrls,
};

// ---------- 解析 guestbook.md ----------
const gbRaw = fs.readFileSync(path.join(ROOT, "src/content/spec/guestbook.md"), "utf8");
const gb = matter(gbRaw);
const guestbook = {
	title: gb.data.title || "",
	description: gb.data.description || "",
	content: gb.content.replace(/^\n+/, ""),
};

// ---------- 解析 musicConfig.ts ----------
const musicPath = path.join(ROOT, "src/config/musicConfig.ts");
const musicSrc = fs.readFileSync(musicPath, "utf8");
const musicMatch = musicSrc.match(/export const musicPlayerConfig[^=]*=\s*(\{[\s\S]*\})\s*;?\s*$/);
if (!musicMatch) {
	console.error("无法从 musicConfig.ts 中提取配置对象");
	process.exit(1);
}
const musicRaw = new Function(`return (${musicMatch[1]});`)();
const music = {
	showInNavbar: musicRaw.showInNavbar !== false,
	showInSidebar: musicRaw.showInSidebar !== false,
	mode: musicRaw.mode === "meting" ? "meting" : "local",
	volume: Number.isFinite(Number(musicRaw.volume)) ? Math.min(1, Math.max(0, Number(musicRaw.volume))) : 0.7,
	playMode: ["list", "one", "random"].includes(musicRaw.playMode) ? musicRaw.playMode : "list",
	showLyrics: musicRaw.showLyrics === true,
	meting: {
		api: (musicRaw.meting && musicRaw.meting.api) || "",
		server: (musicRaw.meting && musicRaw.meting.server) || "netease",
		type: (musicRaw.meting && musicRaw.meting.type) || "playlist",
		id: (musicRaw.meting && musicRaw.meting.id) || "",
		auth: (musicRaw.meting && musicRaw.meting.auth) || "",
		fallbackApis: Array.isArray(musicRaw.meting && musicRaw.meting.fallbackApis)
			? musicRaw.meting.fallbackApis
			: [],
	},
	local: {
		playlist: ((musicRaw.local && musicRaw.local.playlist) || []).map((song) => ({
			name: song.name || "",
			artist: song.artist || "",
			url: song.url || "",
			cover: song.cover || "",
			lrc: song.lrc || "",
		})),
	},
};

// ---------- 解析背景图片（src/config/backgroundWallpaperImages.ts） ----------
const bgPath = path.join(ROOT, "src/config/backgroundWallpaperImages.ts");
let background = null;
if (fs.existsSync(bgPath)) {
	const bgSrc = fs.readFileSync(bgPath, "utf8");
	const bgMatch = bgSrc.match(/export const backgroundWallpaperImages[^=]*=\s*(\{[\s\S]*\})\s*;?\s*$/);
	if (bgMatch) {
		const bgRaw = new Function(`return (${bgMatch[1]});`)();
		background = {
			desktop: Array.isArray(bgRaw.desktop) ? bgRaw.desktop.map(String) : [],
			mobile: Array.isArray(bgRaw.mobile) ? bgRaw.mobile.map(String) : [],
		};
	} else {
		console.warn("无法从 backgroundWallpaperImages.ts 中提取图片列表，跳过背景图片");
	}
} else {
	console.warn("未找到 backgroundWallpaperImages.ts，跳过背景图片");
}

// ---------- 解析动态文件（src/content/dynamic/*.md） ----------
// 仓库中的 YAML 时间戳（无时区）按 UTC 解释，这里用 getUTC* 还原为 "YYYY-MM-DD HH:mm:ss" 文本
const fmtUtc = (d) => {
	if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
		`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
	);
};

const dynamicDir = path.join(ROOT, "src/content/dynamic");
const dynamicItems = [];
if (fs.existsSync(dynamicDir)) {
	const files = fs
		.readdirSync(dynamicDir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	for (const file of files) {
		const raw = fs.readFileSync(path.join(dynamicDir, file), "utf8");
		const parsed = matter(raw);
		const item = {
			id: file.replace(/\.md$/, ""),
			published: fmtUtc(parsed.data.published),
			content: parsed.content.replace(/^\n+/, ""),
		};
		if (parsed.data.location) item.location = String(parsed.data.location);
		if (parsed.data.pinned === true) item.pinned = true;
		dynamicItems.push(item);
	}
}
const dynamic = { items: dynamicItems };

const payload = { settings: { gallery, guestbook, music, dynamic, background } };

// ---------- 输出或写入 ----------
const presentKeys = Object.keys(payload.settings).filter((k) => payload.settings[k] != null);

const outFile = getOpt("--out");
if (outFile) {
	fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
	console.log(`已写入 ${outFile}`);
	console.log(
		`相册 ${albums.length} 个（远程图片 ${Object.values(photoUrls).flat().length} 张），` +
			`留言板标题：${guestbook.title || "(空)"}，歌曲 ${music.local.playlist.length} 首，动态 ${dynamicItems.length} 条，` +
			`背景图片 桌面 ${background ? background.desktop.length : "?"} 张 / 移动 ${background ? background.mobile.length : "?"} 张`
	);
}

const sqlFile = getOpt("--sql");
if (sqlFile) {
	const esc = (s) => s.replace(/'/g, "''");
	const stmts = presentKeys.map((key) => {
		const json = JSON.stringify(payload.settings[key]);
		return `INSERT INTO settings (key, value) VALUES ('${key}', '${esc(json)}') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;`;
	});
	fs.writeFileSync(sqlFile, stmts.join("\n") + "\n", "utf8");
	console.log(`SQL 已写入 ${sqlFile}（${presentKeys.join("、")}）`);
}

if (hasFlag("--put")) {
	const token = process.env.ADMIN_TOKEN;
	if (!token) {
		console.error("缺少 ADMIN_TOKEN");
		process.exit(1);
	}
	for (const key of presentKeys) {
		const res = await fetch(`${SOURCE}/api/admin/settings`, {
			method: "PUT",
			headers: { Authorization: token, "Content-Type": "application/json" },
			body: JSON.stringify({ key, value: payload.settings[key] }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data.success) {
			console.error(`写入 ${key} 失败：${data.message || res.status}`);
			process.exit(1);
		}
		console.log(`已写入 ${key}：${data.message}`);
	}
}
