import type { MusicPlayerConfig } from "../types/musicConfig";

// 音乐播放器配置（本文件由管理控制台自动生成，请勿手动修改）
// 如需增删歌曲或调整播放设置，请在控制台的「音乐管理」中编辑后执行「发布」。

export const musicPlayerConfig: MusicPlayerConfig = {
	showInNavbar: true,
	showInSidebar: true,

	mode: "local",
	volume: 0.7,
	playMode: "list",
	showLyrics: false,

	meting: {
		api: "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
		server: "netease",
		type: "playlist",
		id: "10046455237",
		auth: "",
		fallbackApis: [
			"https://api.injahow.cn/meting/?server=:server&type=:type&id=:id",
			"https://api.moeyao.cn/meting/?server=:server&type=:type&id=:id",
		],
	},

	local: {
		playlist: [
			{
				name: "HEAVEN",
				artist: "Ailee",
				url: "/assets/music/Ailee-HEAVEN.mp3",
				cover: "/assets/music/cover/HEAVEN.jpg",
				lrc: "",
			},
			{
				name: "The Other Side Of Paradise",
				artist: "Glass Animals",
				url: "/assets/music/Glass Animals - The Other Side Of Paradise.mp3",
				cover: "/assets/music/cover/the other side of paradise.jpg",
				lrc: "",
			},
			{
				name: "Blinding Lights",
				artist: "The Weeknd",
				url: "/assets/music/The Weeknd - Blinding Lights.mp3",
				cover: "/assets/music/cover/Blinding Lights.jpg",
				lrc: "",
			},
			{
				name: "Die For You",
				artist: "The Weeknd",
				url: "/assets/music/The Weeknd - Die For You.mp3",
				cover: "/assets/music/cover/die for you.jpg",
				lrc: "",
			},
			{
				name: "The Hills",
				artist: "The Weeknd",
				url: "/assets/music/The Weeknd - The Hills.mp3",
				cover: "/assets/music/cover/The Hills.jpg",
				lrc: "",
			},
			{
				name: "模特",
				artist: "李荣浩",
				url: "/assets/music/李荣浩 - 模特.mp3",
				cover: "/assets/music/cover/李荣浩.jpg",
				lrc: "",
			},
		],
	},
};
