/**
 * set_webhook.js - Gestor y Diagnóstico de Webhook para Telegram
 * Uso:
 *   1. Consultar estado: node scripts/set_webhook.js
 *   2. Registrar URL:   node scripts/set_webhook.js https://tu-proyecto.vercel.app/api/telegram
 *   3. Eliminar Webhook (volver a polling): node scripts/set_webhook.js delete
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Cargar .env si existe
const REPO_ROOT = path.resolve(__dirname, '..');
try {
  const envPath = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
} catch (e) {}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ Se requiere TELEGRAM_BOT_TOKEN en variables de entorno o archivo .env.");
  process.exit(1);
}

const targetUrl = process.argv[2];

function telegramGet(apiMethod) {
  return new Promise((resolve) => {
    https.get(`https://api.telegram.org/bot${token}/${apiMethod}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false, raw: d }); }
      });
    }).on('error', err => resolve({ ok: false, error: err.message }));
  });
}

async function main() {
  console.log("==================================================");
  console.log("📡 DIAGNÓSTICO Y REGISTRO DE WEBHOOK TELEGRAM");
  console.log("==================================================");

  // 1. Verificar Bot
  const me = await telegramGet('getMe');
  if (!me.ok) {
    console.error("❌ Token inválido o sin conexión con Telegram:", me.description || me.error);
    process.exit(1);
  }
  console.log(`🤖 Bot Oficial: @${me.result.username} (${me.result.first_name})`);

  // 2. Si se solicitó eliminar webhook
  if (targetUrl === 'delete' || targetUrl === 'remove') {
    console.log("🔄 Eliminando webhook actual...");
    const delRes = await telegramGet('deleteWebhook?drop_pending_updates=false');
    console.log(delRes.ok ? "✅ Webhook eliminado exitosamente. El bot puede operar en modo Long Polling." : "❌ Error:", delRes);
    return;
  }

  // 3. Si se proporcionó una URL para registrar
  if (targetUrl && targetUrl.startsWith('http')) {
    console.log(`🚀 Registrando nuevo Webhook hacia: ${targetUrl}...`);
    const encodedUrl = encodeURIComponent(targetUrl);
    const setRes = await telegramGet(`setWebhook?url=${encodedUrl}&drop_pending_updates=false`);
    if (setRes.ok) {
      console.log("✅ ¡Webhook registrado con éxito en los servidores de Telegram!");
    } else {
      console.error("❌ Telegram rechazó la URL:", setRes.description || setRes);
    }
  }

  // 4. Mostrar estado actual del Webhook
  console.log("\n📋 Estado Actual del Webhook (getWebhookInfo):");
  const info = await telegramGet('getWebhookInfo');
  if (info.ok) {
    console.log(`  🌐 URL Registrada:      ${info.result.url || "(Ninguna - Modo Polling local activo)"}`);
    console.log(`  ⏳ Mensajes Pendientes: ${info.result.pending_update_count || 0}`);
    if (info.result.last_error_message) {
      console.log(`  ⚠️ Último Error:        ${info.result.last_error_message}`);
      console.log(`  📅 Fecha de Error:      ${new Date(info.result.last_error_date * 1000).toLocaleString()}`);
    } else {
      console.log(`  ✅ Estado de Salud:     Excelente (Cero errores de entrega)`);
    }
  } else {
    console.error("No se pudo obtener información del webhook:", info);
  }
  console.log("==================================================");
}

main();
