import type { GalleryConfig } from "@/types/galleryConfig";

// 本文件由管理控制台的数据自动生成（scripts/sync-d1-posts.mjs 写入），
// 请不要手动修改；如需调整相册，请在控制台的「相册管理」中编辑后执行「发布」。
// 本地图片：把图片放入 public/gallery/<相册ID>/ 目录（构建时自动扫描）；
// 远程图片：在控制台「相册管理」中编辑对应相册的图片 URL 列表。

export const galleryConfig: GalleryConfig = {
	albums: [
		{
			id: "1",
			name: "杂图设置",
			description: "测试用图片",
			location: "one",
			date: "2026-10-03",
			tags: ["one", "杂图"],
		},
		{
			id: "2",
			name: "加密相册示例",
			description:
				"这是一个加密相册的示例，设置了访问密码，只有输入正确的密码才能查看相册内容。",
			location: "two",
			date: "2026-10-03",
			tags: ["加密相册", "示例"],
			password: "123456",
			passwordHint: "示例密码123456",
		},
	],

	// 瀑布流最小列宽(px)，浏览器根据容器宽度自动计算列数，默认 240
	columnWidth: 240,
};
