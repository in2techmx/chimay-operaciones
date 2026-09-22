/**
 * api/standup.js - Endpoint Serverless para Push Matutino de Daily Standup
 * Desplegable en Vercel Cron Jobs (08:30 AM Lun-Vie) / Peticiones manuales
 * Proyecto Chimay / in2techmx/chimay-operaciones
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const scrumMaster = require('../scripts/scrum_master_ai.js');

function getBotToken() {
  if (process.env.Telegram_API_Key) return process.env.Telegram_API_Key.trim();
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  if (process.env.TELEGRAM_API_KEY) return process.env.TELEGRAM_API_KEY.trim();
  if (process.env.TELEGRAM_TOKEN) return process.env.TELEGRAM_TOKEN.trim();
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();

  const key = Object.keys(process.env).find(k => 
    /telegram/i.test(k) && /(token|api|key)/i.test(k)
  );
  if (key && process.env[key]) return process.env[key].trim();
  return '';
}

function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
          [{ text: "🏠 Menú Principal", callback_data: "cmd_menu" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
        ]
      }
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          resolve({ ok: false, raw: d });
        }
      });
    });

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(postData);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const botToken = getBotToken();

  try {
    // 1. Generar el Daily Standup con el Agente Scrum Master IA
    const standupText = await scrumMaster.generateDailyStandup();

    // 2. Localizar usuarios receptores (Administradores / Web Master con Telegram ID)
    const dataDir = path.join(process.cwd(), 'data');
    const usersPath = path.join(dataDir, 'usuarios.json');
    let users = [];
    if (fs.existsSync(usersPath)) {
      try {
        users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
      } catch (e) {}
    }

    const recipients = [];
    if (Array.isArray(users)) {
      users.forEach(u => {
        if (u.telegramId) recipients.push(u.telegramId);
      });
    }

    // Si hay un canal o grupo configurado en env
    if (process.env.TELEGRAM_GROUP_CHAT_ID) {
      recipients.push(process.env.TELEGRAM_GROUP_CHAT_ID);
    }

    // Destinatario por defecto si la lista estuviera vacía (Arturo A.)
    if (recipients.length === 0) {
      recipients.push(8272587658);
    }

    const deliveryResults = [];
    if (botToken) {
      for (const chatId of Array.from(new Set(recipients))) {
        const result = await sendTelegramMessage(botToken, chatId, standupText);
        deliveryResults.push({ chatId, ok: result ? result.ok : false });
      }
    }

    return res.status(200).json({
      status: "success",
      timestamp: new Date().toISOString(),
      recipientsDelivered: deliveryResults,
      standupPreview: standupText.substring(0, 150) + "..."
    });
  } catch (err) {
    console.error("[Standup Push Error]:", err);
    return res.status(500).json({ error: err.message });
  }
};
