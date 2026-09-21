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

function getBotToken() {
  return (
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.API_TELEGRAM ||
    process.env.TELEGRAM_API ||
    process.env.TELEGRAM_API_KEY ||
    process.env.telegram_bot_token ||
    process.env.Telegram_Bot_Token ||
    ''
  ).trim();
}

function callTelegramApi(botToken, method, payload) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/${method}`,
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
          resolve({ ok: false, error: 'Invalid JSON response from Telegram', raw: d });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ ok: false, error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

async function sendTelegramMessage(botToken, chatId, messageObj) {
  if (!botToken || !chatId) return null;

  const basePayload = {
    chat_id: chatId,
    text: messageObj.text
  };

  if (messageObj.keyboard) {
    basePayload.reply_markup = {
      inline_keyboard: messageObj.keyboard
    };
  }

  // 1. Intentar con parse_mode: "Markdown"
  const mdPayload = { ...basePayload, parse_mode: "Markdown" };
  const res = await callTelegramApi(botToken, 'sendMessage', mdPayload);

  // 2. Si Telegram rechaza el formato Markdown (ej. caracteres reservados sin escapar), reintentar en texto plano
  if (!res || !res.ok) {
    return await callTelegramApi(botToken, 'sendMessage', basePayload);
  }

  return res;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const botToken = getBotToken();

  // Health check para monitoreo en navegador o pingers
  if (req.method === 'GET') {
    const matchingEnv = Object.keys(process.env).filter(k => 
      k.toUpperCase().includes('TELEGRAM') || k.toUpperCase().includes('TOKEN') || k.toUpperCase().includes('BOT')
    );

    return res.status(200).json({
      status: "online",
      service: "ChimayOpsBot Telegram Webhook 24/7",
      timestamp: new Date().toISOString(),
      repo: "in2techmx/chimay-operaciones",
      hasToken: !!botToken,
      tokenLength: botToken ? botToken.length : 0,
      detectedEnvVars: matchingEnv
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed. Use POST for Telegram Webhook." });
  }

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

    if (reply && message.chat && message.chat.id) {
      if (botToken) {
        // Enviar explícitamente y esperar (await) para asegurar que el contenedor no se congele
        const apiResult = await sendTelegramMessage(botToken, message.chat.id, reply);
        return res.status(200).json({ ok: true, apiResult: apiResult });
      }

      // Si no hay botToken configurado en env, usar respuesta directa de Webhook
      const webhookResponse = {
        method: "sendMessage",
        chat_id: message.chat.id,
        text: reply.text
      };
      if (reply.keyboard) {
        webhookResponse.reply_markup = { inline_keyboard: reply.keyboard };
      }
      return res.status(200).json(webhookResponse);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Webhook Exception]:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
};
