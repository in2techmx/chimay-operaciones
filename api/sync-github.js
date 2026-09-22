/**
 * api/sync-github.js - Endpoint Serverless para Sincronización Git-as-a-Database
 * Desplegable en Vercel / Node.js
 * Permite guardar y commitear cambios en tareas.json directamente en el repositorio GitHub (in2techmx/chimay-operaciones)
 */

const path = require('path');
const fs = require('fs');
const { commitFileToGitHub, getFileShaFromGitHub } = require('../scripts/github_api_sync.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Health-check y verificación de token
  if (req.method === 'GET') {
    const hasToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    return res.status(200).json({
      status: "online",
      service: "Chimay Git-as-a-Database Sync API",
      repo: "in2techmx/chimay-operaciones",
      hasServerToken: hasToken,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    if (!body) {
      return res.status(400).json({ error: "Missing body payload" });
    }

    const { filePath, content, commitMessage, authorUser, token } = body;

    if (!filePath || content === undefined) {
      return res.status(400).json({ error: "filePath and content are required" });
    }

    const authToken = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!authToken) {
      return res.status(401).json({
        ok: false,
        error: "No GitHub Token configured on server or in request. Please configure a GitHub Token."
      });
    }

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const msg = commitMessage || `chore(data): sincronizar ${filePath} vía Git-as-a-Database`;

    const success = await commitFileToGitHub(filePath, contentStr, msg, authorUser, authToken);

    if (success) {
      return res.status(200).json({
        ok: true,
        message: `Commit realizado con éxito en ${filePath}`,
        filePath: filePath,
        timestamp: new Date().toISOString()
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: `Error al realizar commit en GitHub para ${filePath}`
      });
    }
  } catch (err) {
    console.error("[api/sync-github Error]:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
