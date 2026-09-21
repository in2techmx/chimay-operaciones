/**
 * api/telegram.js - Endpoint Serverless Webhook para Telegram (24/7 en la Nube)
 * Desplegable en Vercel / AWS Lambda / Google Cloud Functions
 * Proyecto Chimay / in2techmx/chimay-operaciones
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

// Cargar motor conversacional y sincronizador
const botModule = require('../scripts/telegram_bot.js');
const { commitFileToGitHub } = require('../scripts/github_api_sync.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health check para monitoreo en navegador o pingers
  if (req.method === 'GET') {
    return res.status(200).json({
      status: "online",
      service: "ChimayOpsBot Telegram Webhook 24/7",
      timestamp: new Date().toISOString(),
      repo: "in2techmx/chimay-operaciones",
      hasToken: !!process.env.TELEGRAM_BOT_TOKEN
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed. Use POST for Telegram Webhook." });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  try {
    let update = req.body;
    if (typeof update === 'string') {
      try {
        update = JSON.parse(update);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    if (!update) {
      return res.status(200).json({ ok: true, note: "No update payload" });
    }

    let message = null;
    if (update.message) {
      message = update.message;
    } else if (update.callback_query) {
      message = {
        from: update.callback_query.from,
        chat: update.callback_query.message ? update.callback_query.message.chat : { id: update.callback_query.from.id },
        text: update.callback_query.data.replace(/_/g, ' ')
      };
    }

    if (!message || !message.from) {
      return res.status(200).json({ ok: true, note: "Update without message" });
    }

    // Procesar mensaje con todas las reglas de negocio
    const reply = botModule.processTelegramMessage(message.from, message.text, message, botToken);

    // Responder directamente a Telegram usando el protocolo nativo de Webhook Response
    if (reply && message.chat && message.chat.id) {
      const webhookResponse = {
        method: "sendMessage",
        chat_id: message.chat.id,
        text: reply.text,
        parse_mode: "Markdown"
      };

      if (reply.keyboard) {
        webhookResponse.reply_markup = {
          inline_keyboard: reply.keyboard
        };
      }

      // Si tenemos botToken, también enviamos por Bot API como garantía
      if (botToken) {
        sendTelegramMessageFallback(botToken, message.chat.id, reply).catch(() => {});
      }

      return res.status(200).json(webhookResponse);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Webhook Exception]:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
};

function sendTelegramMessageFallback(botToken, chatId, messageObj) {
  const payload = {
    chat_id: chatId,
    text: messageObj.text,
    parse_mode: "Markdown"
  };

  if (messageObj.keyboard) {
    payload.reply_markup = {
      inline_keyboard: messageObj.keyboard
    };
  }

  const postData = JSON.stringify(payload);
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

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', (e) => {
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}
