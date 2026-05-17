# 🎵 Discord Music Bot

บอทเปิดเพลงจาก YouTube สำหรับ Discord Server

## คำสั่งทั้งหมด

| คำสั่ง | คำอธิบาย |
|--------|----------|
| `!play <ชื่อเพลง / URL>` | เล่นเพลง หรือเพิ่มเข้าคิว |
| `!skip` | ข้ามเพลงปัจจุบัน |
| `!stop` | หยุดเล่นและออกจากห้อง |
| `!queue` | ดูคิวเพลงทั้งหมด |
| `!pause` | หยุดชั่วคราว |
| `!resume` | เล่นต่อ |
| `!np` | ดูเพลงที่กำลังเล่นอยู่ |
| `!volume <0-100>` | ปรับระดับเสียง |
| `!help` | แสดงคำสั่งทั้งหมด |

## วิธีติดตั้ง

### 1. สร้าง Discord Bot

1. ไปที่ [Discord Developer Portal](https://discord.com/developers/applications)
2. กด **New Application** → ตั้งชื่อบอท → กด **Create**
3. ไปที่เมนู **Bot** (ซ้ายมือ)
4. กด **Reset Token** → **Copy** token เก็บไว้
5. เปิด **Privileged Gateway Intents** ทั้ง 3 ตัว:
   - Presence Intent
   - Server Members Intent
   - **Message Content Intent** ← สำคัญมาก!

### 2. เชิญบอทเข้า Server

1. ไปที่เมนู **OAuth2 → URL Generator**
2. เลือก Scopes: `bot`, `applications.commands`
3. เลือก Permissions:
   - Send Messages
   - Embed Links
   - Connect
   - Speak
   - Use Voice Activity
4. Copy URL ที่ได้ → เปิดในเบราว์เซอร์ → เลือก Server → Authorize

### 3. ติดตั้งและรันบอท

```bash
# ติดตั้ง dependencies
npm install

# รันบอท
DISCORD_TOKEN=your_token_here node index.js
```

หรือสร้างไฟล์ `.env` แล้วใช้ `dotenv`:

```bash
npm install dotenv
```

แล้วเพิ่มบรรทัดนี้ที่บนสุดของ `index.js`:
```js
require('dotenv').config();
```

### 4. ต้องติดตั้งเพิ่ม (สำหรับ VPS/Server)

```bash
# FFmpeg จำเป็นสำหรับการเล่นเสียง
sudo apt install ffmpeg
```

## Tech Stack

- **discord.js** v14 — Discord API wrapper
- **@discordjs/voice** — Voice connection
- **play-dl** — YouTube search & streaming
- **opusscript** — Opus audio encoding

## Troubleshooting

- **บอทเข้าห้องแต่ไม่มีเสียง**: ตรวจสอบว่าติดตั้ง `ffmpeg` แล้ว
- **Error: Message Content Intent**: เปิด Message Content Intent ใน Developer Portal
- **ค้นหาเพลงไม่เจอ**: ลองใช้ YouTube URL โดยตรง
