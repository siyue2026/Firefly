/**
 * 同步脚本：从线上数据库拉取文章与站点设置（相册/留言板/音乐/动态），写入博客仓库文件，
 * 让博客以控制台数据为准。由发布脚本（scripts/publish-site.mjs）在构建前调用；
 * 正常情况下不需要手动执行。
 *
 * 用法：
 *   ADMIN_TOKEN=xxx node scripts/sync-d1-posts.mjs                 # 写入仓库文件
 *   ADMIN_TOKEN=xxx node scripts/sync-d1-posts.mjs --dry           # 只预览，不写文件
 *   node scripts/sync-d1-posts.mjs --data dump.json                # 用本地 JSON 数据预览
 *   ADMIN_TOKEN=xxx node scripts/sync-d1-posts.mjs --strict        # 拉取失败时报错退出
 *
 * 行为：
 * - 文章：status=deleted 的删除对应文件；按 slug 生成 src/content/posts 下的 markdown
 * - 相册：从 settings.gallery 重新生成 src/config/galleryConfig.ts 与各相册的 urls.txt
 * - 留言板：从 settings.guestbook 重新生成 src/content/spec/guestbook.md
 * - 音乐：从 settings.music 重新生成 src/config/musicConfig.ts
 * - 动态：从 settings.dynamic 重新生成 src/content/dynamic/<id>.md（deleted=true 的删除文件）
 * - 背景图片：从 settings.background 重新生成 src/config/backgroundWallpaperImages.ts
 * - 拉取失败且未加 --strict：打警告并正常退出（保底使用仓库中现有文件）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const args = process.argv.slice(2);
const getOpt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const OUT_DIR = path.resolve(getOpt("--out") || "src/content/posts");
const SOURCE = (process.env.PUBLISH_SOURCE || "https://firefly-cv5.pages.dev").replace(/\/+$/, "");
const DATA_FILE = getOpt("--data");
const IS_DRY = hasFlag("--dry");
const STRICT = hasFlag("--strict");

const ALBUM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let payload = null;
if (DATA_FILE) {
	payload = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} else {
	const token = process.env.ADMIN_TOKEN;
	if (!token) {
		if (STRICT) {
			console.error("[sync] 缺少 ADMIN_TOKEN，无法同步");
			process.exit(1);
		}
		console.warn("[sync] 未设置 ADMIN_TOKEN，跳过同步（使用仓库现有内容）");
		process.exit(0);
	}
	try {
		const res = await fetch(`${SOURCE}/api/admin/export`, { headers: { Authorization: token } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		payload = await res.json();
	} catch (err) {
		if (STRICT) {
			console.error(`[sync] 拉取线上数据失败：${err.message}`);
			process.exit(1);
		}
		console.warn(`[sync] 拉取线上数据失败（${err.message}），跳过同步`);
		process.exit(0);
	}
}

function safeResolve(rel) {
	if (!rel) return null;
	const full = path.resolve(OUT_DIR, rel);
	const relCheck = path.relative(OUT_DIR, full);
	if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
	return full;
}

function repoResolve(rel) {
	if (!rel) return null;
	const full = path.resolve(process.cwd(), rel);
	const relCheck = path.relative(process.cwd(), full);
	if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
	return full;
}

function toDate(value) {
	if (!value) return new Date();
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? value : d;
}

// 动态时间：控制台以 "YYYY-MM-DD HH:mm:ss" 存储，按 UTC 解释（与博客端 YAML 无时区时间戳的解析保持一致）
function dynamicPublishDate(value) {
	const s = String(value || "").trim();
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
	if (m) {
		return new Date(
			Date.UTC(
				Number(m[1]),
				Number(m[2]) - 1,
				Number(m[3]),
				Number(m[4] || 0),
				Number(m[5] || 0),
				Number(m[6] || 0)
			)
		);
	}
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ---------- 写入/删除文件（记录变化，--dry 时只预览） ----------
let changedFiles = 0;

function writeFileTracked(rel, content) {
	const full = repoResolve(rel);
	if (!full) {
		console.warn(`[sync] 忽略非法路径: ${rel}`);
		return;
	}
	const old = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
	if (old === content) return;
	if (!IS_DRY) {
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
	}
	changedFiles++;
	console.log(`[sync] ${IS_DRY ? "将更新" : "已更新"} ${rel}`);
}

function removeFileTracked(rel) {
	const full = repoResolve(rel);
	if (!full || !fs.existsSync(full)) return;
	if (!IS_DRY) fs.rmSync(full);
	changedFiles++;
	console.log(`[sync] ${IS_DRY ? "将删除" : "已删除"} ${rel}`);
}

// ---------- 文章同步 ----------
let written = 0;
let removed = 0;

if (Array.isArray(payload.posts)) {
	for (const p of payload.posts) {
		if (!p || !p.slug) continue;
		const isMdx = !!(p.file_path && p.file_path.toLowerCase().endsWith(".mdx"));
		const targetRel = `${p.slug}${isMdx ? ".mdx" : ".md"}`;
		const targetFull = safeResolve(targetRel);
		if (!targetFull) {
			console.warn(`[sync] 忽略非法 slug: ${p.slug}`);
			continue;
		}

		if (p.status === "deleted") {
			for (const rel of [targetRel, p.file_path].filter(Boolean)) {
				const full = safeResolve(rel);
				if (full && fs.existsSync(full)) {
					if (!IS_DRY) fs.rmSync(full);
					removed++;
					console.log(`[sync] ${IS_DRY ? "将删除" : "已删除"} ${rel}`);
				}
			}
			continue;
		}

		let meta = {};
		try {
			meta = JSON.parse(p.meta || "{}");
		} catch {
			console.warn(`[sync] ${p.slug} 的 meta 不是合法 JSON，已忽略`);
		}
		const fm = { title: p.title, published: toDate(p.published_at) };
		for (const [k, v] of Object.entries(meta)) {
			if (["title", "description", "draft", "published"].includes(k)) continue;
			if (v === undefined || v === null) continue;
			if (!(k in fm)) fm[k] = k === "updated" ? toDate(v) : v;
		}
		fm.description = p.excerpt || "";
		if (p.status === "draft") fm.draft = true;

		const out = matter.stringify(p.content ?? "", fm);
		if (!IS_DRY) {
			fs.mkdirSync(path.dirname(targetFull), { recursive: true });
			fs.writeFileSync(targetFull, out, "utf8");
		}
		written++;
		console.log(`[sync] ${IS_DRY ? "将写入" : "已写入"} ${targetRel}`);

		// 改名后的旧文件清理
		if (p.file_path && p.file_path !== targetRel) {
			const oldFull = safeResolve(p.file_path);
			if (oldFull && fs.existsSync(oldFull)) {
				if (!IS_DRY) fs.rmSync(oldFull);
				removed++;
				console.log(`[sync] ${IS_DRY ? "将移除" : "已移除"}旧文件 ${p.file_path}`);
			}
		}
	}
} else {
	console.warn("[sync] 数据中没有 posts 字段，跳过文章同步");
}

// ---------- 相册同步（src/config/galleryConfig.ts + public/gallery/<id>/urls.txt） ----------
const tsString = (s) => JSON.stringify(String(s));

// 用项目自带 biome 格式化生成内容，保证与仓库代码风格一致（biome 不可用时原样返回）
function formatWithBiome(content, filePathForBiome) {
	try {
		return execSync(`npx biome format --stdin-file-path=${filePathForBiome}`, {
			input: content,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			timeout: 20000,
		});
	} catch {
		return content;
	}
}

function genGalleryConfigFile(gallery) {
	const lines = [
		'import type { GalleryConfig } from "@/types/galleryConfig";',
		"",
		"// 本文件由管理控制台的数据自动生成（scripts/sync-d1-posts.mjs 写入），",
		"// 请不要手动修改；如需调整相册，请在控制台的「相册管理」中编辑后执行「发布」。",
		"// 本地图片：把图片放入 public/gallery/<相册ID>/ 目录（构建时自动扫描）；",
		"// 远程图片：在控制台「相册管理」中编辑对应相册的图片 URL 列表。",
		"",
		"export const galleryConfig: GalleryConfig = {",
		"\talbums: [",
	];
	for (const a of gallery.albums) {
		lines.push("\t\t{");
		lines.push(`\t\t\tid: ${tsString(a.id)},`);
		lines.push(`\t\t\tname: ${tsString(a.name)},`);
		if (a.description) lines.push(`\t\t\tdescription: ${tsString(a.description)},`);
		if (a.location) lines.push(`\t\t\tlocation: ${tsString(a.location)},`);
		if (a.date) lines.push(`\t\t\tdate: ${tsString(a.date)},`);
		if (Array.isArray(a.tags) && a.tags.length) {
			lines.push(`\t\t\ttags: [${a.tags.map(tsString).join(", ")}],`);
		}
		if (a.cover) lines.push(`\t\t\tcover: ${tsString(a.cover)},`);
		if (a.password) lines.push(`\t\t\tpassword: ${tsString(a.password)},`);
		if (a.passwordHint) lines.push(`\t\t\tpasswordHint: ${tsString(a.passwordHint)},`);
		lines.push("\t\t},");
	}
	lines.push("\t],");
	lines.push("");
	lines.push("\t// 瀑布流最小列宽(px)，浏览器根据容器宽度自动计算列数，默认 240");
	lines.push(`\tcolumnWidth: ${gallery.columnWidth || 240},`);
	lines.push("};");
	lines.push("");
	return lines.join("\n");
}

if (payload.settings && payload.settings.gallery) {
	const gallery = payload.settings.gallery;

	if (Array.isArray(gallery.albums)) {
		writeFileTracked(
			"src/config/galleryConfig.ts",
			formatWithBiome(genGalleryConfigFile(gallery), "src/config/galleryConfig.ts")
		);
	}

	const photoUrls = gallery.photoUrls && typeof gallery.photoUrls === "object" ? gallery.photoUrls : {};
	for (const [id, urls] of Object.entries(photoUrls)) {
		if (!ALBUM_ID_RE.test(id)) {
			console.warn(`[sync] 忽略非法相册 ID 的图片列表: ${id}`);
			continue;
		}
		const rel = `public/gallery/${id}/urls.txt`;
		const list = (Array.isArray(urls) ? urls : [])
			.map((u) => String(u).trim())
			.filter(Boolean);
		if (list.length) {
			const content =
				"# 每行一个图片 URL，支持 jpg/png/webp/avif/gif后缀\n" +
				"# 本文件由控制台生成（scripts/sync-d1-posts.mjs），请勿手动修改\n" +
				list.join("\n") + "\n";
			writeFileTracked(rel, content);
		} else {
			removeFileTracked(rel);
		}
	}
} else if (!DATA_FILE) {
	console.warn("[sync] 线上数据中没有相册设置，跳过相册同步");
}

// ---------- 留言板同步（src/content/spec/guestbook.md） ----------
if (payload.settings && payload.settings.guestbook) {
	const gb = payload.settings.guestbook;
	const fm = {};
	if (gb.title) fm.title = gb.title;
	if (gb.description) fm.description = gb.description;
	let content = typeof gb.content === "string" ? gb.content : "";
	if (content && !content.startsWith("\n")) content = "\n" + content;
	const out = Object.keys(fm).length
		? matter.stringify(content, fm)
		: content;
	writeFileTracked("src/content/spec/guestbook.md", out);
} else if (!DATA_FILE) {
	console.warn("[sync] 线上数据中没有留言板设置，跳过留言板同步");
}

// ---------- 音乐同步（src/config/musicConfig.ts） ----------
function genMusicConfigFile(music) {
	const q = tsString;
	const meting = music.meting && typeof music.meting === "object" ? music.meting : {};
	const playlist =
		music.local && Array.isArray(music.local.playlist) ? music.local.playlist : [];
	const volume = Number(music.volume);
	const lines = [
		'import type { MusicPlayerConfig } from "../types/musicConfig";',
		"",
		"// 音乐播放器配置（本文件由管理控制台自动生成，请勿手动修改）",
		"// 如需增删歌曲或调整播放设置，请在控制台的「音乐管理」中编辑后执行「发布」。",
		"",
		"export const musicPlayerConfig: MusicPlayerConfig = {",
		`\tshowInNavbar: ${music.showInNavbar !== false},`,
		`\tshowInSidebar: ${music.showInSidebar !== false},`,
		"",
		`\tmode: ${q(music.mode === "meting" ? "meting" : "local")},`,
		`\tvolume: ${Number.isFinite(volume) ? Math.min(1, Math.max(0, Math.round(volume * 100) / 100)) : 0.7},`,
		`\tplayMode: ${q(["list", "one", "random"].includes(music.playMode) ? music.playMode : "list")},`,
		`\tshowLyrics: ${music.showLyrics === true},`,
		"",
		"\tmeting: {",
		`\t\tapi: ${q(meting.api || "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r")},`,
		`\t\tserver: ${q(meting.server || "netease")},`,
		`\t\ttype: ${q(meting.type || "playlist")},`,
		`\t\tid: ${q(meting.id || "")},`,
		`\t\tauth: ${q(meting.auth || "")},`,
		`\t\tfallbackApis: [${(Array.isArray(meting.fallbackApis) ? meting.fallbackApis : []).map(q).join(", ")}],`,
		"\t},",
		"",
		"\tlocal: {",
		"\t\tplaylist: [",
	];
	for (const song of playlist) {
		if (!song || typeof song !== "object") continue;
		lines.push("\t\t\t{");
		lines.push(`\t\t\t\tname: ${q(String(song.name || ""))},`);
		lines.push(`\t\t\t\tartist: ${q(String(song.artist || ""))},`);
		lines.push(`\t\t\t\turl: ${q(String(song.url || ""))},`);
		lines.push(`\t\t\t\tcover: ${q(String(song.cover || ""))},`);
		lines.push(`\t\t\t\tlrc: ${q(String(song.lrc || ""))},`);
		lines.push("\t\t\t},");
	}
	lines.push("\t\t],");
	lines.push("\t},");
	lines.push("};");
	lines.push("");
	return lines.join("\n");
}

if (payload.settings && payload.settings.music) {
	writeFileTracked(
		"src/config/musicConfig.ts",
		formatWithBiome(genMusicConfigFile(payload.settings.music), "src/config/musicConfig.ts")
	);
} else if (!DATA_FILE) {
	console.warn("[sync] 线上数据中没有音乐设置，跳过音乐同步");
}

// ---------- 背景图片同步（src/config/backgroundWallpaperImages.ts） ----------
function genBackgroundImagesFile(background) {
	const q = tsString;
	const listLines = (name, list) => {
		if (!list.length) return [`\t${name}: [],`];
		return [`\t${name}: [`, ...list.map((u) => `\t\t${q(u)},`), "\t],"];
	};
	const desktop = Array.isArray(background.desktop) ? background.desktop : [];
	const mobile = Array.isArray(background.mobile) ? background.mobile : [];
	const lines = [
		"// 本文件由管理控制台的数据自动生成（scripts/sync-d1-posts.mjs 写入），请勿手动修改。",
		"// 如需调整博客背景图片，请在控制台的「背景管理」中编辑后执行「发布」。",
		"// 图片路径支持：远程 URL（https://...）、public 目录（/assets/images/xxx.jpg）、",
		"// 或仓库图片相对 src 的路径（assets/images/DesktopWallpaper/xxx.jpg）。",
		"",
		"export const backgroundWallpaperImages = {",
		...listLines("desktop", desktop),
		...listLines("mobile", mobile),
		"};",
		"",
	];
	return lines.join("\n");
}

if (payload.settings && payload.settings.background) {
	writeFileTracked(
		"src/config/backgroundWallpaperImages.ts",
		formatWithBiome(genBackgroundImagesFile(payload.settings.background), "src/config/backgroundWallpaperImages.ts")
	);
} else if (!DATA_FILE) {
	console.warn("[sync] 线上数据中没有背景图片设置，跳过背景图片同步");
}

// ---------- 动态同步（src/content/dynamic/<id>.md） ----------
if (payload.settings && payload.settings.dynamic) {
	const dyn = payload.settings.dynamic;
	const items = Array.isArray(dyn.items) ? dyn.items : [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const id = String(item.id || "");
		if (!ALBUM_ID_RE.test(id)) {
			console.warn(`[sync] 忽略非法动态 ID: ${id || "(空)"}`);
			continue;
		}
		const rel = `src/content/dynamic/${id}.md`;
		if (item.deleted === true) {
			removeFileTracked(rel);
			continue;
		}
		const fm = { published: dynamicPublishDate(item.published) };
		if (item.pinned === true) fm.pinned = true;
		if (item.location) fm.location = String(item.location);
		let content = typeof item.content === "string" ? item.content : "";
		if (content && !content.startsWith("\n")) content = "\n" + content;
		writeFileTracked(rel, matter.stringify(content, fm));
	}
} else if (!DATA_FILE) {
	console.warn("[sync] 线上数据中没有动态设置，跳过动态同步");
}

console.log(
	`[sync] 完成：文章写入 ${written} 篇、删除 ${removed} 个文件；其余文件变更 ${changedFiles} 个${IS_DRY ? "（演练模式）" : ""}`
);
