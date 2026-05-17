require("dotenv").config({ path: "/Users/blackjay/Documents/MacBook Pro Jay/Bot/.env" });
const { Client, GatewayIntentBits } = require("discord.js");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});
client.on("messageCreate", (msg) => {
  if (!msg.author.bot) console.log(`✅ MSG: "${msg.content}" from ${msg.author.tag}`);
});
client.once("ready", () => console.log(`✅ Ready as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
