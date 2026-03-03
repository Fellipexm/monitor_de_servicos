const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: false,
    args: ["--no-sandbox"]
  }
});

client.on("qr", qr => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("WHATSAPP PRONTO\n");

  const chats = await client.getChats();

  console.log("==== GRUPOS ====\n");

  chats.forEach(chat => {
    if (chat.isGroup) {
      console.log(chat.name);
      console.log(chat.id._serialized);
      console.log("--------------------");
    }
  });
});

client.initialize();
