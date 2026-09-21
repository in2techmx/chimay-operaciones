/**
 * github_api_sync.js - Sincronizador Git-as-a-Database para Entornos Serverless
 * Permite realizar commits directos en GitHub (in2techmx/chimay-operaciones)
 * desde funciones en la nube (Vercel, Cloudflare, etc.) sin requerir binario local de git.
 */

const https = require('https');

const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'in2techmx';
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || 'chimay-operaciones';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

function githubApiRequest(method, endpoint, body = null, token = null) {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken) {
    return Promise.resolve({ ok: false, error: "No GITHUB_TOKEN configured" });
  }

  const postData = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'api.github.com',
    port: 443,
    path: endpoint,
    method: method,
    headers: {
      'User-Agent': 'ChimayOpsBot-Serverless',
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${authToken}`
    }
  };

  if (postData) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(postData);
  }

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, error: data });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// Obtener SHA y contenido actual de un archivo en GitHub
async function getFileShaFromGitHub(filePath, token = null) {
  const endpoint = `/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const res = await githubApiRequest('GET', endpoint, null, token);
  if (res.ok && res.data && res.data.sha) {
    return res.data.sha;
  }
  return null;
}

// Realizar commit de un archivo en GitHub
async function commitFileToGitHub(filePath, contentString, commitMessage, authorUser = null, token = null) {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken) {
    console.warn("[GitHub API] No GITHUB_TOKEN configurado. Omitiendo commit en la nube.");
    return false;
  }

  try {
    const existingSha = await getFileShaFromGitHub(filePath, authToken);
    const contentBase64 = Buffer.from(contentString, 'utf8').toString('base64');

    const authorName = (authorUser && authorUser.nombre) ? authorUser.nombre : "ChimayOpsBot";
    const authorEmail = (authorUser && authorUser.email) ? authorUser.email : "252501165+in2techmx@users.noreply.github.com";

    const payload = {
      message: commitMessage,
      content: contentBase64,
      branch: GITHUB_BRANCH,
      committer: {
        name: authorName,
        email: authorEmail
      }
    };

    if (existingSha) {
      payload.sha = existingSha;
    }

    const endpoint = `/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${filePath}`;
    const res = await githubApiRequest('PUT', endpoint, payload, authToken);

    if (res.ok) {
      console.log(`[GitHub API] Commit exitoso en ${filePath}: "${commitMessage}"`);
      return true;
    } else {
      console.error(`[GitHub API] Error haciendo commit en ${filePath}:`, res.data || res.error);
      return false;
    }
  } catch (err) {
    console.error("[GitHub API] Excepción al realizar commit:", err.message);
    return false;
  }
}

module.exports = {
  githubApiRequest,
  getFileShaFromGitHub,
  commitFileToGitHub
};
