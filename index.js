// ============================================
// 🎵 Discord Music Bot
// ============================================
// Commands:
//   !play <ชื่อเพลง / YouTube URL>  - เล่นเพลง / เพิ่มเข้าคิว
//   !search <ชื่อเพลง>              - ค้นหาและเลือกเพลง
//   !skip                            - ข้ามเพลง
//   !stop                            - หยุดเล่นและออกจากห้อง
//   !queue                           - ดูคิวเพลง
//   !remove <เลขที่>                - ลบเพลงออกจากคิว
//   !clear                           - ล้างคิวทั้งหมด
//   !pause                           - หยุดชั่วคราว
//   !resume                          - เล่นต่อ
//   !np                              - เพลงที่กำลังเล่นอยู่
//   !volume <0-100>                  - ปรับเสียง
//   !loop [song/queue/off]           - วนซ้ำเพลง/คิว/ปิด
//   !shuffle                         - สับเปลี่ยนลำดับคิว
//   !help                            - ดูคำสั่งทั้งหมด
// ============================================

require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require("@discordjs/voice");
const play = require("play-dl");
const { spawn } = require("child_process");
const which = require("which");
// หา yt-dlp อัตโนมัติ (รองรับทั้ง Mac และ Linux server)
const YTDLP = process.env.YTDLP_PATH || which.sync("yt-dlp", { nothrow: true }) || "yt-dlp";
// ใช้ ffmpeg จาก package แทน system ffmpeg
const ffmpegStatic = require("ffmpeg-static");
process.env.FFMPEG_PATH = ffmpegStatic;
// ---------- Vertex AI (Node.js) — เทียบเท่า vertexai.init() ใน Python ----------
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || "botj-496614";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "global";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const VERTEX_URL = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${GEMINI_MODEL}`;

async function vertexGenerate(contents, systemInstruction) {
  const body = { contents };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  const res = await fetch(`${VERTEX_URL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.error || data));
  return data.candidates[0].content.parts[0].text;
}

// wrapper สำหรับให้โค้ดส่วนล่างเรียกใช้แบบเดิม
const genAI = {
  models: {
    generateContent: async ({ contents }) => ({ text: await vertexGenerate([{ role: "user", parts: [{ text: contents }] }]) }),
  },
  chats: {
    create: ({ history, config }) => ({
      sendMessage: async ({ message }) => ({
        text: await vertexGenerate(
          [...(history || []), { role: "user", parts: [{ text: message }] }],
          config?.systemInstruction
        ),
      }),
    }),
  },
};
// เก็บประวัติการสนทนาแต่ละ channel
const chatHistories = new Map();
// เก็บ vote skip แต่ละ guild
const voteSkips = new Map();

// ---------- Database ----------
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "./bot.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    name TEXT,
    songs TEXT,
    UNIQUE(guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS user_memory (
    user_id TEXT,
    guild_id TEXT,
    memory TEXT,
    PRIMARY KEY(user_id, guild_id)
  );
  CREATE TABLE IF NOT EXISTS chat_history (
    channel_id TEXT,
    guild_id TEXT,
    history TEXT,
    updated_at INTEGER,
    PRIMARY KEY(channel_id)
  );
`);

// ---------- Config ----------
const TOKEN = process.env.DISCORD_TOKEN; // ใส่ Token ใน .env หรือ environment variable
const PREFIX = "!";

// ---------- Bot Setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// เก็บข้อมูลเพลงแต่ละ server (guild)
const queues = new Map();

// เก็บ pending search sessions (userId -> { results, timeout })
const searchSessions = new Map();

// ---------- Helper: สร้าง/ดึง queue ของ guild ----------
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      player: null,
      connection: null,
      volume: 50,
      playing: false,
      textChannel: null,
      loop: "off", // "off" | "song" | "queue"
    });
  }
  return queues.get(guildId);
}

// ---------- Helper: Embed สวยๆ ----------
function songEmbed(title, description, color = 0x5865f2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

// ---------- เล่นเพลงถัดไปในคิว ----------
async function playSong(guild, queue) {
  if (queue.songs.length === 0) {
    queue.playing = false;
    if (queue.connection) {
      queue.connection.destroy();
      queue.connection = null;
    }
    queues.delete(guild.id);
    return;
  }

  const song = queue.songs[0];
  queue.playing = true;

  try {
    const ytdlp = spawn(YTDLP, [
      "-f", "bestaudio",
      "-o", "-",
      "--no-playlist",
      "-q",
      song.url,
    ]);
    const ffmpegProcess = spawn(ffmpegStatic, [
      "-i", "pipe:0",
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-c:a", "libopus",
      "-f", "ogg",
      "-ar", "48000",
      "-ac", "2",
      "-b:a", "128k",
      "pipe:1",
    ]);
    ytdlp.stdout.pipe(ffmpegProcess.stdin);
    ytdlp.stderr.on("data", () => {});
    ytdlp.stdout.on("error", () => {});
    ffmpegProcess.stdin.on("error", () => {});
    ffmpegProcess.stdout.on("error", () => {});
    ffmpegProcess.stderr.on("data", () => {});
    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.OggOpus,
      inlineVolume: true,
    });
    resource.volume?.setVolume(queue.volume / 100);

    queue.player.play(resource);

    queue.textChannel?.send({
      embeds: [
        songEmbed(
          "🎶 กำลังเล่น",
          `**[${song.title}](${song.url})**\nความยาว: \`${song.duration}\`\nขอโดย: ${song.requestedBy}`,
          0x57f287
        ),
      ],
    });
  } catch (err) {
    console.error("Error playing song:", err);
    queue.textChannel?.send({
      embeds: [
        songEmbed(
          "❌ เกิดข้อผิดพลาด",
          `ไม่สามารถเล่นเพลง **${song.title}** ได้\n\`${err.message}\``,
          0xed4245
        ),
      ],
    });
    queue.songs.shift();
    playSong(guild, queue);
  }
}

// ---------- Debug: ตรวจสอบ message events ----------
client.on("messageCreate", (msg) => {
  if (!msg.author.bot) console.log(`[RAW MSG] from: ${msg.author.tag} | content: ${msg.content}`);
});
client.on("debug", (info) => {
  console.log("[GW DEBUG]", info);
});

// ---------- Bot Ready ----------
client.once("ready", () => {
  console.log(`✅ Bot พร้อมใช้งาน! Logged in as ${client.user.tag}`);
  console.log(`[GUILDS] อยู่ใน ${client.guilds.cache.size} server(s):`);
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  client.user.setActivity("!help | 🎵 Music Bot", { type: 2 }); // type 2 = Listening
});

// ---------- Message Handler ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  if (!message.guild) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  console.log(`[CMD] ${message.author.tag}: !${command} ${args.join(" ")}`);

  // ==================== !play ====================
  if (command === "play" || command === "p") {
    const query = args.join(" ");
    if (!query) {
      return message.reply({
        embeds: [
          songEmbed(
            "❗ กรุณาใส่ชื่อเพลงหรือ URL",
            "ตัวอย่าง: `!play ชื่อเพลง` หรือ `!play https://youtube.com/...`",
            0xfee75c
          ),
        ],
      });
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply({
        embeds: [
          songEmbed(
            "❗ เข้าห้องเสียงก่อนนะ!",
            "คุณต้องอยู่ใน Voice Channel ก่อนจึงจะใช้คำสั่งนี้ได้",
            0xfee75c
          ),
        ],
      });
    }

    const queue = getQueue(message.guild.id);
    queue.textChannel = message.channel;

    // ค้นหาเพลง
    let songInfo;
    try {
      let searchResult;

      if (play.yt_validate(query) === "video") {
        // ถ้าเป็น YouTube URL
        const info = await play.video_info(query);
        searchResult = info.video_details;
      } else {
        // ค้นหาจากชื่อ
        const results = await play.search(query, { limit: 1 });
        if (!results || results.length === 0) {
          return message.reply({
            embeds: [
              songEmbed("❌ ไม่พบเพลง", `ไม่พบผลลัพธ์สำหรับ: \`${query}\``, 0xed4245),
            ],
          });
        }
        searchResult = results[0];
      }

      const videoUrl =
        searchResult.url ||
        (searchResult.id ? `https://www.youtube.com/watch?v=${searchResult.id}` : null);

      if (!videoUrl) {
        return message.reply({
          embeds: [songEmbed("❌ ไม่พบ URL ของเพลง", "ลองใช้ YouTube URL โดยตรงแทนครับ", 0xed4245)],
        });
      }

      songInfo = {
        title: searchResult.title,
        url: videoUrl,
        duration: searchResult.durationRaw || "N/A",
        thumbnail: searchResult.thumbnails?.[0]?.url || null,
        requestedBy: message.author.toString(),
      };
    } catch (err) {
      console.error("Search error:", err);
      return message.reply({
        embeds: [
          songEmbed("❌ ค้นหาไม่สำเร็จ", `\`${err.message}\``, 0xed4245),
        ],
      });
    }

    queue.songs.push(songInfo);

    // ถ้ายังไม่ได้เชื่อมต่อ voice channel
    if (!queue.connection) {
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
        });

        const player = createAudioPlayer();

        player.on(AudioPlayerStatus.Idle, () => {
          if (queue.loop === "song") {
            // วนซ้ำเพลงเดิม (ไม่ shift)
          } else if (queue.loop === "queue") {
            // ย้ายเพลงแรกไปท้ายสุด
            const finished = queue.songs.shift();
            if (finished) queue.songs.push(finished);
          } else {
            queue.songs.shift();
          }
          playSong(message.guild, queue);
        });

        player.on("error", (err) => {
          console.error("Player error:", err);
          queue.songs.shift();
          playSong(message.guild, queue);
        });

        connection.subscribe(player);
        queue.connection = connection;
        queue.player = player;

        // เริ่มเล่นเพลงแรก
        playSong(message.guild, queue);
      } catch (err) {
        console.error("Connection error:", err);
        queues.delete(message.guild.id);
        return message.reply({
          embeds: [
            songEmbed("❌ เชื่อมต่อไม่ได้", `\`${err.message}\``, 0xed4245),
          ],
        });
      }
    } else {
      // เพิ่มเข้าคิว
      message.channel.send({
        embeds: [
          songEmbed(
            "📋 เพิ่มเข้าคิวแล้ว",
            `**[${songInfo.title}](${songInfo.url})**\nลำดับที่: \`#${queue.songs.length}\`\nขอโดย: ${songInfo.requestedBy}`,
            0x5865f2
          ),
        ],
      });
    }
  }

  // ==================== !skip ====================
  else if (command === "skip" || command === "s") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)],
      });
    }
    message.channel.send({
      embeds: [songEmbed("⏭️ ข้ามเพลง", `ข้ามเพลง **${queue.songs[0]?.title}**`, 0x5865f2)],
    });
    queue.player.stop();
  }

  // ==================== !stop ====================
  else if (command === "stop" || command === "leave" || command === "dc") {
    const queue = queues.get(message.guild.id);
    if (!queue) {
      return message.reply({
        embeds: [songEmbed("❗", "บอทไม่ได้อยู่ใน Voice Channel", 0xfee75c)],
      });
    }
    queue.songs = [];
    queue.player?.stop();
    queue.connection?.destroy();
    queues.delete(message.guild.id);
    message.channel.send({
      embeds: [songEmbed("👋 ออกจากห้องแล้ว", "หยุดเล่นเพลงและออกจาก Voice Channel", 0xed4245)],
    });
  }

  // ==================== !queue ====================
  else if (command === "queue" || command === "q") {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply({
        embeds: [songEmbed("📋 คิวเพลง", "คิวว่างเปล่า ใช้ `!play` เพื่อเพิ่มเพลง", 0xfee75c)],
      });
    }
    const songList = queue.songs
      .map((s, i) => {
        const prefix = i === 0 ? "▶️ กำลังเล่น" : `${i}.`;
        return `${prefix} **${s.title}** [\`${s.duration}\`]`;
      })
      .slice(0, 15)
      .join("\n");

    const remaining = queue.songs.length > 15 ? `\n...และอีก ${queue.songs.length - 15} เพลง` : "";

    message.channel.send({
      embeds: [
        songEmbed("📋 คิวเพลง", `${songList}${remaining}\n\n**ทั้งหมด ${queue.songs.length} เพลง**`, 0x5865f2),
      ],
    });
  }

  // ==================== !pause ====================
  else if (command === "pause") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)],
      });
    }
    queue.player.pause();
    message.channel.send({
      embeds: [songEmbed("⏸️ หยุดชั่วคราว", "ใช้ `!resume` เพื่อเล่นต่อ", 0xfee75c)],
    });
  }

  // ==================== !resume ====================
  else if (command === "resume") {
    const queue = queues.get(message.guild.id);
    if (!queue) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงในคิว", 0xfee75c)],
      });
    }
    queue.player.unpause();
    message.channel.send({
      embeds: [songEmbed("▶️ เล่นต่อ", `กำลังเล่น **${queue.songs[0]?.title}**`, 0x57f287)],
    });
  }

  // ==================== !np (Now Playing) ====================
  else if (command === "np" || command === "nowplaying") {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)],
      });
    }
    const song = queue.songs[0];
    message.channel.send({
      embeds: [
        songEmbed(
          "🎵 กำลังเล่นอยู่ตอนนี้",
          `**[${song.title}](${song.url})**\nความยาว: \`${song.duration}\`\nขอโดย: ${song.requestedBy}\n🔊 Volume: \`${queue.volume}%\``,
          0x57f287
        ),
      ],
    });
  }

  // ==================== !loop ====================
  else if (command === "loop" || command === "repeat") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)],
      });
    }

    const mode = args[0]?.toLowerCase();
    const validModes = { song: "song", queue: "queue", off: "off", s: "song", q: "queue" };

    if (!mode || !validModes[mode]) {
      // สลับไปโหมดถัดไปถ้าไม่ระบุ
      const cycle = { off: "song", song: "queue", queue: "off" };
      queue.loop = cycle[queue.loop];
    } else {
      queue.loop = validModes[mode];
    }

    const loopEmoji = { off: "➡️", song: "🔂", queue: "🔁" };
    const loopLabel = { off: "ปิด", song: "วนซ้ำเพลงนี้", queue: "วนซ้ำทั้งคิว" };
    message.channel.send({
      embeds: [songEmbed(`${loopEmoji[queue.loop]} Loop`, `โหมด: **${loopLabel[queue.loop]}**`, 0x5865f2)],
    });
  }

  // ==================== !shuffle ====================
  else if (command === "shuffle") {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length <= 1) {
      return message.reply({
        embeds: [songEmbed("❗", "ต้องมีเพลงในคิวอย่างน้อย 2 เพลง", 0xfee75c)],
      });
    }
    // สับเฉพาะเพลงในคิว (ไม่นับเพลงที่กำลังเล่น index 0)
    const current = queue.songs[0];
    const rest = queue.songs.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue.songs = [current, ...rest];
    message.channel.send({
      embeds: [songEmbed("🔀 สับคิวแล้ว", `สับลำดับ ${rest.length} เพลงในคิวเรียบร้อย`, 0x5865f2)],
    });
  }

  // ==================== !remove ====================
  else if (command === "remove" || command === "rm") {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) {
      return message.reply({
        embeds: [songEmbed("❗", "คิวว่างเปล่า", 0xfee75c)],
      });
    }

    const index = parseInt(args[0]);
    if (isNaN(index) || index < 1 || index >= queue.songs.length) {
      return message.reply({
        embeds: [
          songEmbed(
            "❗ เลขที่ไม่ถูกต้อง",
            `ใส่เลขที่ 1–${queue.songs.length - 1} (เพลงที่กำลังเล่นลบไม่ได้ ใช้ \`!skip\` แทน)`,
            0xfee75c
          ),
        ],
      });
    }

    const removed = queue.songs.splice(index, 1)[0];
    message.channel.send({
      embeds: [songEmbed("🗑️ ลบออกจากคิวแล้ว", `**${removed.title}**`, 0xed4245)],
    });
  }

  // ==================== !clear ====================
  else if (command === "clear" || command === "cls") {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.songs.length <= 1) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงในคิวที่จะล้าง", 0xfee75c)],
      });
    }
    const count = queue.songs.length - 1;
    queue.songs = [queue.songs[0]]; // เก็บเพลงที่กำลังเล่นอยู่
    message.channel.send({
      embeds: [songEmbed("🧹 ล้างคิวแล้ว", `ลบ ${count} เพลงออกจากคิว (เพลงปัจจุบันยังเล่นอยู่)`, 0xed4245)],
    });
  }

  // ==================== !search ====================
  else if (command === "search" || command === "find") {
    const query = args.join(" ");
    if (!query) {
      return message.reply({
        embeds: [songEmbed("❗", "กรุณาใส่ชื่อเพลงที่ต้องการค้นหา", 0xfee75c)],
      });
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply({
        embeds: [songEmbed("❗ เข้าห้องเสียงก่อนนะ!", "คุณต้องอยู่ใน Voice Channel ก่อน", 0xfee75c)],
      });
    }

    let results;
    try {
      results = await play.search(query, { limit: 5 });
    } catch (err) {
      return message.reply({
        embeds: [songEmbed("❌ ค้นหาไม่สำเร็จ", `\`${err.message}\``, 0xed4245)],
      });
    }

    if (!results || results.length === 0) {
      return message.reply({
        embeds: [songEmbed("❌ ไม่พบเพลง", `ไม่พบผลลัพธ์สำหรับ: \`${query}\``, 0xed4245)],
      });
    }

    const list = results
      .map((r, i) => `**${i + 1}.** [${r.title}](${r.url}) [\`${r.durationRaw || "N/A"}\`]`)
      .join("\n");

    await message.channel.send({
      embeds: [
        songEmbed(
          `🔍 ผลลัพธ์สำหรับ "${query}"`,
          `${list}\n\nพิมพ์ **1–${results.length}** เพื่อเลือก หรือ **cancel** เพื่อยกเลิก (หมดเวลา 30 วินาที)`,
          0x5865f2
        ),
      ],
    });

    // เก็บ session รอผู้ใช้เลือก
    const timeout = setTimeout(() => {
      searchSessions.delete(message.author.id);
      message.channel.send({
        embeds: [songEmbed("⏱️ หมดเวลา", "ยกเลิกการค้นหา", 0xfee75c)],
      });
    }, 30000);

    searchSessions.set(message.author.id, {
      results,
      guildId: message.guild.id,
      voiceChannel,
      textChannel: message.channel,
      timeout,
    });
  }

  // ==================== !skipto ====================
  else if (command === "skipto" || command === "st") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply({ embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)] });
    }
    const index = parseInt(args[0]);
    if (isNaN(index) || index < 2 || index > queue.songs.length) {
      return message.reply({ embeds: [songEmbed("❗", `ใส่เลขที่ 2–${queue.songs.length} ครับ`, 0xfee75c)] });
    }
    const song = queue.songs[index - 1];
    queue.songs = [song, ...queue.songs.slice(index)];
    message.channel.send({ embeds: [songEmbed("⏩ ข้ามไปเพลงที่ " + index, `**${song.title}**`, 0x5865f2)] });
    queue.player.stop();
  }

  // ==================== !volume ====================
  else if (command === "volume" || command === "vol" || command === "v") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply({
        embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่นอยู่", 0xfee75c)],
      });
    }

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      return message.reply({
        embeds: [
          songEmbed("❗", `Volume ปัจจุบัน: \`${queue.volume}%\`\nใช้ \`!volume 0-100\` เพื่อปรับ`, 0xfee75c),
        ],
      });
    }

    queue.volume = vol;
    // Volume จะมีผลกับเพลงถัดไป (resource ปัจจุบันไม่สามารถเปลี่ยนได้ง่าย)
    message.channel.send({
      embeds: [songEmbed("🔊 ปรับเสียง", `Volume: \`${vol}%\``, 0x5865f2)],
    });
  }

  // ==================== !help ====================
  else if (command === "help" || command === "h") {
    const helpText = [
      "`!play <ชื่อ/URL>` — เล่นเพลงหรือเพิ่มเข้าคิว",
      "`!search <ชื่อ>` — ค้นหาและเลือกเพลงจากรายการ",
      "`!skip` — ข้ามเพลงปัจจุบัน",
      "`!stop` — หยุดเล่นและออกจากห้อง",
      "`!queue` — ดูคิวเพลงทั้งหมด",
      "`!remove <เลขที่>` — ลบเพลงออกจากคิว",
      "`!clear` — ล้างคิวทั้งหมด (เก็บเพลงปัจจุบัน)",
      "`!pause` — หยุดชั่วคราว",
      "`!resume` — เล่นต่อ",
      "`!np` — ดูเพลงที่กำลังเล่น",
      "`!volume <0-100>` — ปรับระดับเสียง",
      "`!loop [song/queue/off]` — วนซ้ำเพลง/คิว/ปิด",
      "`!shuffle` — สับเปลี่ยนลำดับคิว",
      "`!help` — แสดงคำสั่งทั้งหมด",
    ].join("\n");

    message.channel.send({
      embeds: [songEmbed("🎵 Music Bot — คำสั่งทั้งหมด", helpText, 0x5865f2)],
    });
  }
});

// ---------- Search Session Handler ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const session = searchSessions.get(message.author.id);
  if (!session || session.guildId !== message.guild.id) return;

  const content = message.content.trim().toLowerCase();

  if (content === "cancel" || content === "ยกเลิก") {
    clearTimeout(session.timeout);
    searchSessions.delete(message.author.id);
    return message.reply({
      embeds: [songEmbed("❌ ยกเลิกแล้ว", "ยกเลิกการค้นหาเพลง", 0xfee75c)],
    });
  }

  const choice = parseInt(content);
  if (isNaN(choice) || choice < 1 || choice > session.results.length) return;

  clearTimeout(session.timeout);
  searchSessions.delete(message.author.id);

  const picked = session.results[choice - 1];
  const pickedUrl = picked.url || (picked.id ? `https://www.youtube.com/watch?v=${picked.id}` : null);
  const songInfo = {
    title: picked.title,
    url: pickedUrl,
    duration: picked.durationRaw || "N/A",
    thumbnail: picked.thumbnails?.[0]?.url || null,
    requestedBy: message.author.toString(),
  };

  const queue = getQueue(message.guild.id);
  queue.textChannel = session.textChannel;
  queue.songs.push(songInfo);

  if (!queue.connection) {
    try {
      const connection = joinVoiceChannel({
        channelId: session.voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      const player = createAudioPlayer();

      player.on(AudioPlayerStatus.Idle, () => {
        if (queue.loop === "song") {
          // วนซ้ำเพลงเดิม
        } else if (queue.loop === "queue") {
          const finished = queue.songs.shift();
          if (finished) queue.songs.push(finished);
        } else {
          queue.songs.shift();
        }
        playSong(message.guild, queue);
      });

      player.on("error", (err) => {
        console.error("Player error:", err);
        queue.songs.shift();
        playSong(message.guild, queue);
      });

      connection.subscribe(player);
      queue.connection = connection;
      queue.player = player;

      playSong(message.guild, queue);
    } catch (err) {
      queues.delete(message.guild.id);
      return message.reply({
        embeds: [songEmbed("❌ เชื่อมต่อไม่ได้", `\`${err.message}\``, 0xed4245)],
      });
    }
  } else {
    message.channel.send({
      embeds: [
        songEmbed(
          "📋 เพิ่มเข้าคิวแล้ว",
          `**[${songInfo.title}](${songInfo.url})**\nลำดับที่: \`#${queue.songs.length}\`\nขอโดย: ${songInfo.requestedBy}`,
          0x5865f2
        ),
      ],
    });
  }
});

// ---------- Playlist / VoteSkip / Lyrics / AI Advanced ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  if (!message.guild) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ==================== !playlist ====================
  if (command === "playlist" || command === "pl") {
    const sub = args[0]?.toLowerCase();

    // !playlist save <ชื่อ>
    if (sub === "save") {
      const name = args.slice(1).join(" ");
      if (!name) return message.reply({ embeds: [songEmbed("❗", "ใส่ชื่อ playlist ด้วยครับ เช่น `!playlist save เพลงฮิต`", 0xfee75c)] });
      const queue = queues.get(message.guild.id);
      if (!queue || queue.songs.length === 0) return message.reply({ embeds: [songEmbed("❗", "ไม่มีเพลงในคิว", 0xfee75c)] });
      try {
        db.prepare("INSERT OR REPLACE INTO playlists (guild_id, user_id, name, songs) VALUES (?, ?, ?, ?)").run(
          message.guild.id, message.author.id, name, JSON.stringify(queue.songs)
        );
        message.channel.send({ embeds: [songEmbed("💾 บันทึก Playlist แล้ว", `**${name}** — ${queue.songs.length} เพลง`, 0x57f287)] });
      } catch (e) {
        message.reply({ embeds: [songEmbed("❌ Error", e.message, 0xed4245)] });
      }
    }

    // !playlist load <ชื่อ>
    else if (sub === "load") {
      const name = args.slice(1).join(" ");
      if (!name) return message.reply({ embeds: [songEmbed("❗", "ใส่ชื่อ playlist ด้วย เช่น `!playlist load เพลงฮิต`", 0xfee75c)] });
      const row = db.prepare("SELECT * FROM playlists WHERE guild_id = ? AND name = ?").get(message.guild.id, name);
      if (!row) return message.reply({ embeds: [songEmbed("❌ ไม่พบ Playlist", `ไม่มี playlist ชื่อ **${name}**`, 0xed4245)] });

      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) return message.reply({ embeds: [songEmbed("❗", "เข้าห้องเสียงก่อนนะ!", 0xfee75c)] });

      const songs = JSON.parse(row.songs);
      const queue = getQueue(message.guild.id);
      queue.textChannel = message.channel;
      queue.songs.push(...songs);

      message.channel.send({ embeds: [songEmbed("📂 โหลด Playlist แล้ว", `**${name}** — ${songs.length} เพลง`, 0x5865f2)] });

      if (!queue.connection) {
        const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
        const player = createAudioPlayer();
        player.on(AudioPlayerStatus.Idle, () => {
          if (queue.loop === "song") {}
          else if (queue.loop === "queue") { const f = queue.songs.shift(); if (f) queue.songs.push(f); }
          else queue.songs.shift();
          playSong(message.guild, queue);
        });
        player.on("error", () => { queue.songs.shift(); playSong(message.guild, queue); });
        connection.subscribe(player);
        queue.connection = connection;
        queue.player = player;
        playSong(message.guild, queue);
      }
    }

    // !playlist list
    else if (sub === "list") {
      const rows = db.prepare("SELECT name, user_id FROM playlists WHERE guild_id = ?").all(message.guild.id);
      if (rows.length === 0) return message.reply({ embeds: [songEmbed("📋 Playlists", "ยังไม่มี playlist ในเซิร์ฟนี้", 0xfee75c)] });
      const list = rows.map((r, i) => `**${i + 1}.** ${r.name}`).join("\n");
      message.channel.send({ embeds: [songEmbed("📋 Playlists ทั้งหมด", list, 0x5865f2)] });
    }

    // !playlist delete <ชื่อ>
    else if (sub === "delete" || sub === "del") {
      const name = args.slice(1).join(" ");
      if (!name) return message.reply({ embeds: [songEmbed("❗", "ใส่ชื่อ playlist ที่ต้องการลบ", 0xfee75c)] });
      const result = db.prepare("DELETE FROM playlists WHERE guild_id = ? AND name = ? AND user_id = ?").run(message.guild.id, name, message.author.id);
      if (result.changes === 0) return message.reply({ embeds: [songEmbed("❌", "ไม่พบ playlist หรือคุณไม่ใช่เจ้าของ", 0xed4245)] });
      message.channel.send({ embeds: [songEmbed("🗑️ ลบ Playlist แล้ว", `**${name}**`, 0xed4245)] });
    }

    else {
      message.reply({ embeds: [songEmbed("📋 วิธีใช้ Playlist", [
        "`!playlist save <ชื่อ>` — บันทึกคิวปัจจุบัน",
        "`!playlist load <ชื่อ>` — โหลด playlist",
        "`!playlist list` — ดู playlist ทั้งหมด",
        "`!playlist delete <ชื่อ>` — ลบ playlist",
      ].join("\n"), 0x5865f2)] });
    }
  }

  // ==================== !voteskip ====================
  else if (command === "voteskip" || command === "vs") {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) return message.reply({ embeds: [songEmbed("❗", "ไม่มีเพลงที่กำลังเล่น", 0xfee75c)] });

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply({ embeds: [songEmbed("❗", "เข้าห้องเสียงก่อน", 0xfee75c)] });

    const members = voiceChannel.members.filter(m => !m.user.bot).size;
    const needed = Math.ceil(members / 2);

    if (!voteSkips.has(message.guild.id)) voteSkips.set(message.guild.id, new Set());
    const votes = voteSkips.get(message.guild.id);
    votes.add(message.author.id);

    if (votes.size >= needed) {
      voteSkips.delete(message.guild.id);
      queue.player.stop();
      message.channel.send({ embeds: [songEmbed("⏭️ Vote Skip สำเร็จ!", `ได้รับ ${votes.size}/${members} โหวต`, 0x57f287)] });
    } else {
      message.channel.send({ embeds: [songEmbed("🗳️ Vote Skip", `${votes.size}/${needed} โหวต (ต้องการ ${needed} จาก ${members} คน)`, 0x5865f2)] });
    }
  }

  // ==================== !lyrics ====================
  else if (command === "lyrics" || command === "ly") {
    const query = args.join(" ");
    const queue = queues.get(message.guild.id);
    const songName = query || queue?.songs[0]?.title;
    if (!songName) return message.reply({ embeds: [songEmbed("❗", "ใส่ชื่อเพลง หรือเปิดเพลงก่อน", 0xfee75c)] });

    await message.channel.sendTyping();
    try {
      const result = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: `หา lyrics เพลง "${songName}" มาให้หน่อย ถ้าเป็นเพลงไทยให้ใส่ภาษาไทย ถ้าไม่รู้จักเพลงให้บอกตรงๆ อย่าแต่งเอง` });
      const lyrics = result.text;
      const chunks = lyrics.match(/[\s\S]{1,1900}/g) || [lyrics];
      for (const chunk of chunks.slice(0, 3)) {
        await message.channel.send({ embeds: [songEmbed(`🎤 Lyrics: ${songName}`, chunk, 0x5865f2)] });
      }
    } catch (e) {
      message.reply({ embeds: [songEmbed("❌ Error", e.message, 0xed4245)] });
    }
  }

  // ==================== !draw / !วาด ====================
  else if (command === "draw" || command === "วาด" || command === "image" || command === "img") {
    const prompt = args.join(" ");
    if (!prompt) return message.reply({ embeds: [songEmbed("❗", "ใส่คำอธิบายรูปที่ต้องการ เช่น `!draw แมวนอนบนก้อนเมฆ`", 0xfee75c)] });

    const loadingMsg = await message.channel.send({ embeds: [songEmbed("🎨 กำลังวาดรูป...", `**${prompt}**\nรอสักครู่นะครับ`, 0x5865f2)] });

    try {
      // แปลงเป็น English ก่อนเพื่อให้ได้ผลดีขึ้น
      const translated = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: `แปลคำอธิบายนี้เป็นภาษาอังกฤษสำหรับ AI สร้างรูป ตอบแค่ประโยคเดียว: "${prompt}"` });
      const englishPrompt = translated.text.trim();

      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=1024&height=1024&nologo=true&enhance=true`;

      // ดาวน์โหลดรูปแล้วส่งเป็น attachment
      const https = require("https");
      const http = require("http");
      const { PassThrough } = require("stream");

      const getStream = (url) => new Promise((resolve, reject) => {
        const client = url.startsWith("https") ? https : http;
        client.get(url, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) return getStream(res.headers.location).then(resolve).catch(reject);
          const pass = new PassThrough();
          res.pipe(pass);
          resolve(pass);
        }).on("error", reject);
      });

      const stream = await getStream(imageUrl);
      await loadingMsg.delete();
      await message.channel.send({
        content: `🎨 **${prompt}**\n> *${englishPrompt}*`,
        files: [{ attachment: stream, name: "image.png" }],
      });
    } catch (err) {
      await loadingMsg.delete().catch(() => {});
      message.reply({ embeds: [songEmbed("❌ เกิดข้อผิดพลาด", `\`${err.message}\``, 0xed4245)] });
    }
  }

  // ==================== !translate / !แปล ====================
  else if (command === "translate" || command === "tr" || command === "แปล") {
    const text = args.join(" ");
    if (!text) return message.reply({ embeds: [songEmbed("❗", "ใส่ข้อความที่ต้องการแปล เช่น `!แปล hello world`", 0xfee75c)] });
    await message.channel.sendTyping();
    try {
      const result = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: `แปลข้อความนี้เป็นภาษาไทย (ถ้าเป็นไทยอยู่แล้วให้แปลเป็นอังกฤษ): "${text}" ตอบแค่คำแปลอย่างเดียว ไม่ต้องอธิบาย` });
      message.channel.send({ embeds: [songEmbed("🌐 แปลภาษา", `**ต้นฉบับ:** ${text}\n**แปล:** ${result.text}`, 0x5865f2)] });
    } catch (e) {
      message.reply({ embeds: [songEmbed("❌ Error", e.message, 0xed4245)] });
    }
  }

  // ==================== !summary ====================
  else if (command === "summary" || command === "สรุป") {
    await message.channel.sendTyping();
    try {
      const messages = await message.channel.messages.fetch({ limit: 50 });
      const text = messages.reverse().map(m => `${m.author.displayName}: ${m.content}`).filter(t => t.length > 5).join("\n");
      const result = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: `สรุปการสนทนานี้ให้กระชับเป็นภาษาไทย:\n${text}` });
      message.channel.send({ embeds: [songEmbed("📝 สรุปการสนทนา", result.text, 0x5865f2)] });
    } catch (e) {
      message.reply({ embeds: [songEmbed("❌ Error", e.message, 0xed4245)] });
    }
  }
});

// ---------- Sentiment Analysis (ปิดไว้เพื่อประหยัด API quota) ----------
client.on("messageCreate", async (message) => {
  return; // ปิดชั่วคราว
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.content.startsWith(PREFIX)) return;
  if (message.content.length < 5) return;
  if (Math.random() > 0.15) return;

  try {
    const result = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: `วิเคราะห์ความรู้สึกของข้อความนี้: "${message.content}" ตอบด้วย emoji เดียวเท่านั้น เลือกจาก: 😂 😢 😡 😍 😮 👍 เท่านั้น`,
    });
    const emoji = result.text?.trim().match(/[\p{Emoji}]/u)?.[0];
    if (emoji) await message.react(emoji);
  } catch (_) {}
});

// ---------- helpers: โหลด/บันทึกประวัติแชทจาก DB ----------
function loadHistory(channelId) {
  if (chatHistories.has(channelId)) return chatHistories.get(channelId);
  const row = db.prepare("SELECT history FROM chat_history WHERE channel_id = ?").get(channelId);
  const history = row ? JSON.parse(row.history) : [];
  chatHistories.set(channelId, history);
  return history;
}

function saveHistory(channelId, guildId, history) {
  db.prepare("INSERT OR REPLACE INTO chat_history (channel_id, guild_id, history, updated_at) VALUES (?, ?, ?, ?)").run(
    channelId, guildId, JSON.stringify(history), Date.now()
  );
}

// ---------- AI Chat Handler ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const isMentioned = message.mentions.has(client.user);
  const isAICommand = message.content.startsWith(`${PREFIX}ai `);
  const isNameCall = message.content.includes("แจ๊บ");

  if (!isMentioned && !isAICommand && !isNameCall) return;

  let userText = isAICommand
    ? message.content.slice(`${PREFIX}ai `.length).trim()
    : message.content.replace(`<@${client.user.id}>`, "").trim();

  if (!userText) {
    return message.reply({ embeds: [songEmbed("💬", "พิมพ์ข้อความมาด้วยนะ เช่น `!ai สวัสดี` หรือ แท็กฉันแล้วพิมพ์ข้อความ", 0x5865f2)] });
  }

  // คำสั่ง "จำไว้ว่า..." — บันทึกทันที
  const rememberMatch = userText.match(/จำไว้ว่า[:\s]+(.+)/i);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    const existing = db.prepare("SELECT memory FROM user_memory WHERE user_id = ? AND guild_id = ?").get(message.author.id, message.guild.id);
    const updated = existing ? existing.memory + `\n- ${fact}` : `- ${fact}`;
    db.prepare("INSERT OR REPLACE INTO user_memory (user_id, guild_id, memory) VALUES (?, ?, ?)").run(message.author.id, message.guild.id, updated);
    return message.reply({ embeds: [songEmbed("🧠 จำแล้ว!", `บันทึกไว้เรียบร้อยครับ: **${fact}**`, 0x57f287)] });
  }

  const channelId = message.channel.id;
  const history = loadHistory(channelId);

  try {
    await message.channel.sendTyping();

    // ดึงความจำของผู้ใช้จาก database
    const memRow = db.prepare("SELECT memory FROM user_memory WHERE user_id = ? AND guild_id = ?").get(message.author.id, message.guild.id);
    const userMemory = memRow?.memory || "";

    const now = new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "full", timeStyle: "short" });
    const chat = genAI.chats.create({
      model: GEMINI_MODEL,
      history,
      config: {
        systemInstruction: `คุณคือแจ๊บ บอทผู้ช่วยในเซิร์ฟเวอร์ Discord ตอบภาษาไทยเป็นหลัก ใช้ภาษาสบายๆ เป็นกันเอง ห้ามตอบยาวเกินไป\nเวลาและวันที่ปัจจุบัน (ไทย): ${now}${userMemory ? `\n\nข้อมูลเกี่ยวกับผู้ใช้คนนี้: ${userMemory}` : ""}`,
      },
    });

    const result = await chat.sendMessage({ message: `[${message.author.displayName || message.author.username}]: ${userText}` });
    const reply = result.text;

    // บันทึกประวัติใน memory และ DB
    history.push({ role: "user", parts: [{ text: `[${message.author.displayName || message.author.username}]: ${userText}` }] });
    history.push({ role: "model", parts: [{ text: reply }] });

    // จำกัดประวัติไว้ 40 ข้อความ (20 รอบ)
    if (history.length > 40) history.splice(0, 2);

    // บันทึกประวัติแชทลง DB ทุกครั้ง
    saveHistory(channelId, message.guild.id, history);

    // อัปเดตความจำผู้ใช้อัตโนมัติทุก 3 ข้อความ (6 entries = 3 รอบ user+model)
    if (history.length % 6 === 0) {
      try {
        const existing = db.prepare("SELECT memory FROM user_memory WHERE user_id = ? AND guild_id = ?").get(message.author.id, message.guild.id);
        const mem = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: `จากการสนทนานี้ สรุปและอัปเดตข้อมูลสำคัญเกี่ยวกับผู้ใช้ชื่อ "${message.author.displayName || message.author.username}" ให้กระชับ รวมกับข้อมูลเดิม:\n\nข้อมูลเดิม: ${existing?.memory || "ไม่มี"}\n\nบทสนทนาล่าสุด:\n${history.slice(-6).map(h => h.parts[0].text).join("\n")}` });
        db.prepare("INSERT OR REPLACE INTO user_memory (user_id, guild_id, memory) VALUES (?, ?, ?)").run(message.author.id, message.guild.id, mem.text);
      } catch (_) {}
    }

    // ถ้าข้อความยาวเกิน 2000 ตัดให้พอดี
    const response = reply.length > 2000 ? reply.slice(0, 1997) + "..." : reply;
    message.reply(response);
  } catch (err) {
    console.error("Gemini error:", err);
    message.reply({ embeds: [songEmbed("❌ AI Error", `\`${err.message}\``, 0xed4245)] });
  }
});

// ---------- Login ----------
if (!TOKEN) {
  console.error("❌ กรุณาตั้งค่า DISCORD_TOKEN ก่อน!");
  console.error("   วิธี: DISCORD_TOKEN=your_token_here node index.js");
  process.exit(1);
}

client.login(TOKEN);
