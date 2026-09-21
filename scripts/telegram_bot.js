/**
 * telegram_bot.js - Motor Conversacional y Bridge de Telegram para Git-as-a-Database
 * Proyecto Chimay / Operaciones IN2TECHMX
 * Historia de Usuario: US-CHIMAY-TEL-01
 * 
 * Reglas de Negocio Implementadas:
 * 1. Control de Acceso: Whitelist por Telegram ID / Username / PIN contra data/usuarios.json.
 *    Rechazo estricto: "🚫 Acceso no autorizado. Tu ID de Telegram es [XXXXX]. Solicita a Web Master brindarte acceso."
 * 2. Propiedad Estricta: Solo el dueño de la tarea puede cambiar su estado (completar, iniciar).
 * 3. Chat Universal: Cualquier usuario autorizado puede chatear/comentar en cualquier tarea.
 * 4. Creación Universal & Auto-Asignación: Cualquier usuario autorizado puede crear tareas y queda como responsable.
 * 5. Trazabilidad Git: Modifica los archivos JSON modulares de data/ y genera commits en el repositorio.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Rutas base relativas a la raíz del repositorio
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'proyectos.json');
const ATTACHMENTS_FILE = path.join(DATA_DIR, 'adjuntos.json');

// Cargar variables de entorno locales desde .env si existe (sin dependencias npm)
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

// Memoria de sesiones para hilos de tareas enfocadas (1-a-1)
const userSessions = {}; // from.id -> { activeTaskId: "TSK-01" }

function addProjectAttachment(taskId, attachmentObj) {
  let data = loadJson(ATTACHMENTS_FILE, {});
  if (!data || typeof data !== 'object') data = {};
  if (!data[taskId]) data[taskId] = [];
  data[taskId].push(attachmentObj);
  saveJson(ATTACHMENTS_FILE, data);
  return attachmentObj;
}

function downloadTelegramFile(botToken, fileId, destPath) {
  try {
    https.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.ok && json.result && json.result.file_path) {
            const fileUrl = `https://api.telegram.org/file/bot${botToken}/${json.result.file_path}`;
            const fileStream = fs.createWriteStream(destPath);
            https.get(fileUrl, fileRes => {
              fileRes.pipe(fileStream);
            });
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  } catch (err) {}
}

// Utilidades de Archivos JSON con soporte para Serverless y CWD
function loadJson(filePath, defaultValue = null) {
  try {
    let target = filePath;
    if (!fs.existsSync(target)) {
      const rel = path.relative(REPO_ROOT, filePath);
      const cwdTarget = path.join(process.cwd(), rel);
      if (fs.existsSync(cwdTarget)) {
        target = cwdTarget;
      }
    }
    if (fs.existsSync(target)) {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    }
  } catch (err) {
    console.error(`[Error leyendo ${filePath}]:`, err.message);
  }
  return defaultValue;
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Error guardando ${filePath}]:`, err.message);
  }
}

// Cargar Catálogo de Usuarios con fallback serverless
function getAuthorizedUsers() {
  const loaded = loadJson(USERS_FILE, []);
  if (loaded && Array.isArray(loaded) && loaded.length > 0) return loaded;
  return [
    { id: "USR-01", nombre: "Arturo A.", email: "arnaiz.art@gmail.com", usuario: "arnaiz.art", rol: "Web Master (Master Admon)", puedeEditar: true, alcanceEdicion: "todas", telegramId: 8272587658, telegramUser: "in2techmx" },
    { id: "USR-02", nombre: "Arturo B.", email: "arturo.b@in2tech.mx", usuario: "arturo.b", rol: "Gerente Operativo", puedeEditar: true, alcanceEdicion: "todas", telegramUser: "arturo_b" },
    { id: "USR-03", nombre: "Gema R.", email: "gema.r@in2tech.mx", usuario: "gema.r", rol: "Coordinadora de Proyectos", puedeEditar: true, alcanceEdicion: "todas", telegramUser: "gema_r" }
  ];
}

// Autenticar Usuario de Telegram
function authenticateTelegramUser(from) {
  if (!from) return null;
  const users = getAuthorizedUsers();
  const telegramId = from.id;
  const telegramUser = (from.username || "").toLowerCase().replace('@', '');
  const firstName = (from.first_name || "").toLowerCase();

  // 1. Buscar por telegramId exacto
  let matched = users.find(u => u.telegramId && String(u.telegramId) === String(telegramId));
  if (matched) return matched;

  // 2. Buscar por username de Telegram
  if (telegramUser) {
    matched = users.find(u => u.telegramUser && u.telegramUser.toLowerCase() === telegramUser);
    if (matched) {
      // Auto-vincular telegramId para futuras peticiones
      matched.telegramId = telegramId;
      saveJson(USERS_FILE, users);
      return matched;
    }
  }

  // 3. Buscar por alias o coincidencia en usuarios configurados
  for (const u of users) {
    const uName = (u.nombre || "").toLowerCase();
    const uNick = (u.usuario || "").toLowerCase();
    if (firstName && (uName.includes(firstName) || firstName.includes(uNick))) {
      return u;
    }
  }

  return null;
}

// Localizar todas las tareas activas de los proyectos
function getAllProjectTasks() {
  const projects = loadJson(PROJECTS_FILE, []);
  const allTasks = [];

  for (const proj of projects) {
    if (proj.etapas && Array.isArray(proj.etapas)) {
      for (const etapa of proj.etapas) {
        const tareasPath = path.join(DATA_DIR, etapa.path, 'tareas.json');
        const tasks = loadJson(tareasPath, []);
        tasks.forEach(t => {
          allTasks.push({
            ...t,
            _projId: proj.id,
            _etapaPath: etapa.path,
            _tareasFilePath: tareasPath
          });
        });
      }
    }
  }
  return allTasks;
}

// Buscar tarea por ID (ej. TSK-PRE-01 o TSK-01)
function findTaskById(taskId) {
  const cleanId = String(taskId || "").trim().toUpperCase();
  const allTasks = getAllProjectTasks();
  
  // 1. Coincidencia exacta
  let found = allTasks.find(t => String(t.id).toUpperCase() === cleanId);
  if (found) return found;

  // 2. Coincidencia flexible por número terminal (ej. TSK-01 o 01 con TSK-PRE-01)
  const numMatch = cleanId.match(/(\d+)$/);
  if (numMatch) {
    const num = numMatch[1];
    found = allTasks.find(t => {
      const tid = String(t.id).toUpperCase();
      return tid.endsWith(`-${num}`) || tid.endsWith(`-${num.padStart(2, '0')}`);
    });
    if (found) return found;
  }

  return null;
}

// Modificar estado de tarea en su archivo JSON
function updateTaskStatus(task, newStatus, newProgress) {
  const tasksInStage = loadJson(task._tareasFilePath, []);
  const idx = tasksInStage.findIndex(t => String(t.id).toUpperCase() === String(task.id).toUpperCase());
  if (idx !== -1) {
    tasksInStage[idx].estado = newStatus;
    tasksInStage[idx].progress = newProgress;
    tasksInStage[idx].fechaCambioEstado = new Date().toISOString();
    saveJson(task._tareasFilePath, tasksInStage);
    return true;
  }
  return false;
}

// Crear nueva tarea en la etapa activa
function createNewTask(taskName, authorName) {
  const projects = loadJson(PROJECTS_FILE, []);
  if (!projects || projects.length === 0) return null;

  // Tomar el proyecto principal y su última etapa activa
  const proj = projects[0];
  const etapa = (proj.etapas && proj.etapas.length > 0) ? proj.etapas[proj.etapas.length - 1] : null;
  if (!etapa) return null;

  const tareasPath = path.join(DATA_DIR, etapa.path, 'tareas.json');
  const tasksInStage = loadJson(tareasPath, []);

  // Determinar siguiente ID WBS
  const allTasks = getAllProjectTasks();
  let maxNum = 0;
  allTasks.forEach(t => {
    const m = String(t.id).match(/TSK-(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });

  const nextNum = maxNum + 1;
  const newId = `TSK-${String(nextNum).padStart(2, '0')}`;
  const hoy = new Date().toISOString().split('T')[0];
  const fin = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const newTask = {
    id: newId,
    name: taskName,
    responsable: authorName, // Quien la crea queda como dueño
    estado: "No Iniciada",
    progress: 0,
    horas: 8,
    costoPersonal: 1600,
    costoMateriales: 0,
    costoTerceros: 0,
    costoTotal: 1600,
    start: hoy,
    end: fin,
    prioridad: "Media",
    etapa: etapa.slug || "Etapa Operativa"
  };

  tasksInStage.push(newTask);
  saveJson(tareasPath, tasksInStage);

  return { task: newTask, filePath: tareasPath };
}

// Agregar comentario a la bitácora del proyecto
function addProjectComment(projId, taskId, authorName, text) {
  const projects = loadJson(PROJECTS_FILE, []);
  const proj = projects.find(p => p.id === projId || p.slug === projId) || projects[0];
  const projFolder = proj ? (proj.path || `proyectos/${proj.slug || 'PRJ-01-chimay'}`) : 'proyectos/PRJ-01-chimay';
  const commentsPath = path.join(DATA_DIR, projFolder, 'comentarios.json');
  let commentsData = loadJson(commentsPath, {});

  const newComment = {
    id: `COM-${Date.now()}`,
    taskId: taskId || "GENERAL",
    author: authorName,
    message: text,
    timestamp: new Date().toISOString(),
    canal: "Telegram"
  };

  if (Array.isArray(commentsData)) {
    commentsData.push(newComment);
  } else {
    if (!commentsData || typeof commentsData !== 'object') commentsData = {};
    const key = taskId || "GENERAL";
    if (!commentsData[key]) commentsData[key] = [];
    commentsData[key].push(newComment);
  }

  saveJson(commentsPath, commentsData);
  return newComment;
}

// Realizar commit en Git si está configurado
function tryGitCommit(commitMessage, authorUser) {
  if (process.env.ENABLE_GIT_COMMIT !== 'true') {
    return false;
  }
  try {
    const authorEmail = (authorUser && authorUser.email) ? authorUser.email : "252501165+in2techmx@users.noreply.github.com";
    const authorName = (authorUser && authorUser.nombre) ? authorUser.nombre : "Telegram Bot";
    execSync(`git add data/`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git commit -m "${commitMessage}" --author="${authorName} <${authorEmail}>"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

// Normalizador Universal de Instrucciones (Cross-Reference Engine)
function normalizeInstruction(input) {
  if (!input) return "";
  let s = String(input);
  // 1. Descomponer acentos y diacríticos (ej. Menú -> Menu, iniciación -> iniciacion)
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // 2. Eliminar pictogramas y emojis extendidos sin tocar números 0-9 ni letras
  s = s.replace(/[\p{Extended_Pictographic}\uFE0F\u200d\u203C\u2049\u2139\u2194-\u21aa\u231a-\u23fa\u24c2\u25aa-\u27bf\u2934\u2935\u2b05-\u2b55]/gu, ' ');
  // 3. Pasar a minúsculas
  s = s.toLowerCase();
  // 4. Limpiar barras diagonales iniciales (/start -> start) y guiones bajos (callback_data)
  s = s.replace(/^[\/\\]+/, '');
  s = s.replace(/[_]/g, ' ');
  // 5. Limpiar prefijos de sistema comunes
  s = s.replace(/\bcmd\s+/g, '');
  // 6. Colapsar espacios y recortar
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Diccionario y Detector de Intenciones Cross-Reference
function detectIntent(rawText) {
  const raw = (rawText || "").trim();
  const norm = normalizeInstruction(raw);

  if (!norm && !raw) return { type: "VACIO" };

  // 1. Salir / Cancelar modo conversación de tarea
  const salirList = ["salir", "salir tarea", "cancelar", "volver", "atras", "cerrar", "cerrar hilo", "terminar hilo", "menu principal"];
  if (salirList.includes(norm) || norm.startsWith("salir")) {
    return { type: "SALIR_TAREA" };
  }

  // 2. Mis Tareas / Pendientes / Actividades asignadas
  const misTareasKeywords = [
    "mis tareas", "tareas", "pendientes", "mis pendientes", "actividades", 
    "mis actividades", "ver tareas", "ver mis tareas", "consultar tareas", 
    "lista tareas", "lista de tareas", "listar tareas", "tareas asignadas", 
    "que tengo que hacer", "que hago", "mis entregables"
  ];
  if (misTareasKeywords.includes(norm) || norm.includes("mis tareas") || norm.includes("mis pendientes") || norm === "tareas") {
    return { type: "MIS_TAREAS" };
  }

  // 3. Reporte de Avance / Estado / KPIs / Presupuesto
  const reporteKeywords = [
    "reporte", "informe", "estado", "avance", "balance", "costos", 
    "presupuesto", "kpi", "kpis", "salud", "status", "resumen", "dashboard"
  ];
  if (reporteKeywords.includes(norm) || norm.includes("reporte") || norm.includes("avance") || norm.includes("balance") || norm.includes("costos")) {
    return { type: "REPORTE" };
  }

  // 4. Ayuda / Start / Menú / Saludo inicial
  const ayudaKeywords = [
    "start", "ayuda", "menu", "inicio", "hola", "comandos", "help", "opciones", "buenos dias", "buenas tardes"
  ];
  if (ayudaKeywords.includes(norm)) {
    return { type: "AYUDA" };
  }

  // 5. Modo Tarea Enfocada (/start task_[ID], /tarea [ID], tarea [ID], hilo [ID], ver [ID])
  const deepLinkMatch = raw.match(/^\/start\s+task_([a-z0-9\-]+)/i);
  if (deepLinkMatch) {
    return { type: "ENTRAR_TAREA", taskId: deepLinkMatch[1].toUpperCase() };
  }
  const tareaCmdMatch = norm.match(/^(?:tarea|hilo|abrir|ver|entrar|consultar)\s+([a-z0-9\-]+)$/i);
  if (tareaCmdMatch) {
    return { type: "ENTRAR_TAREA", taskId: tareaCmdMatch[1].toUpperCase() };
  }
  // Si el usuario envía directamente el identificador de tarea aislado (ej. "TSK-PRE-01" o "TSK-01")
  const soloIdMatch = norm.match(/^(tsk-[a-z0-9\-]+)$/i);
  if (soloIdMatch) {
    return { type: "ENTRAR_TAREA", taskId: soloIdMatch[1].toUpperCase() };
  }

  // 6. Completar tarea (completar [ID], finalizar [ID], terminar [ID], cerrar [ID], listo [ID])
  const compMatch = norm.match(/^(?:completar|finalizar|terminar|cerrar|concluir|listo|done)\s+([a-z0-9\-]+)$/i);
  if (compMatch) {
    return { type: "COMPLETAR_TAREA", taskId: compMatch[1].toUpperCase() };
  }

  // 7. Iniciar tarea (iniciar [ID], arrancar [ID], empezar [ID], comenzar [ID], progreso [ID])
  const iniMatch = norm.match(/^(?:iniciar|arrancar|empezar|comenzar|progreso)\s+([a-z0-9\-]+)$/i);
  if (iniMatch) {
    return { type: "INICIAR_TAREA", taskId: iniMatch[1].toUpperCase() };
  }

  // 8. Crear nueva tarea (crear [nombre], nueva tarea [nombre], agregar [nombre])
  const crearMatch = norm.match(/^(?:crear(?:\s+tarea)?|nueva(?:\s+tarea)?|agregar(?:\s+tarea)?|anadir(?:\s+tarea)?|registrar(?:\s+tarea)?)\s+(.+)$/i);
  if (crearMatch) {
    const rawMatch = raw.match(/^(?:crear(?:\s+tarea)?|nueva(?:\s+tarea)?|agregar(?:\s+tarea)?|añadir(?:\s+tarea)?|registrar(?:\s+tarea)?)\s+(.+)$/i);
    const taskName = (rawMatch ? rawMatch[1] : crearMatch[1]).trim();
    return { type: "CREAR_TAREA", taskName };
  }

  // 9. Comentar en tarea: [ID]: [comentario] o comentar [ID] [comentario]
  const comentarMatch = raw.match(/^(?:comentar\s+)?(tsk-[a-z0-9\-]+)[:\s]+(.+)$/i);
  if (comentarMatch) {
    return {
      type: "COMENTAR_TAREA",
      taskId: comentarMatch[1].toUpperCase(),
      comment: comentarMatch[2].trim()
    };
  }

  return { type: "DESCONOCIDO", raw, norm };
}

// Procesador Central de Mensajes de Telegram con Crossref Universal
function processTelegramMessage(from, text, messageObj = null, botToken = null) {
  const rawText = (text || "").trim();

  // 1. Verificación de Autenticación (Whitelist RBAC)
  const user = authenticateTelegramUser(from);
  if (!user) {
    // REGLA ESTRICTA DE SEGURIDAD (Gate 2 AS): Zero Info Disclosure. Sin nombres de personal ni detalles de proyecto.
    return {
      authorized: false,
      text: `🚫 *Acceso no autorizado.*\nTu ID de Telegram es \`${from.id}\`.\n\n*Solicita a Web Master brindarte acceso.*`
    };
  }

  // 2. Recepción de Archivos de Soporte (Documentos / Fotos)
  if (messageObj && (messageObj.document || (messageObj.photo && messageObj.photo.length > 0))) {
    let targetId = userSessions[from.id] ? userSessions[from.id].activeTaskId : null;
    let captionText = (messageObj.caption || "").trim();

    const matchCaptionTask = captionText.match(/^(?:tsk-[a-z0-9\-]+)/i);
    if (matchCaptionTask) {
      targetId = matchCaptionTask[0].toUpperCase();
      captionText = captionText.replace(/^(?:tsk-[a-z0-9\-]+)[:\s]*/i, '').trim();
    }

    if (!targetId) {
      return {
        authorized: true,
        text: `📎 *Archivo recibido pero no vinculado:*\n` +
              `Para adjuntar este archivo a una tarea, entra primero escribiendo:\n` +
              `\`/tarea [ID]\` (ej. \`/tarea TSK-PRE-01\`)\n` +
              `o envía el archivo escribiendo el ID en el pie de foto (ej. \`TSK-01: Factura de insumos\`).`
      };
    }

    const task = findTaskById(targetId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${targetId}* para vincular este archivo.`
      };
    }

    let fileId = "";
    let fileName = "";
    let fileSizeStr = "1 MB";
    let tipo = "document";

    if (messageObj.document) {
      fileId = messageObj.document.file_id;
      fileName = messageObj.document.file_name || `Doc_${Date.now()}.pdf`;
      const sizeBytes = messageObj.document.file_size || 0;
      fileSizeStr = sizeBytes > 1024 * 1024 ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(sizeBytes / 1024) + " KB";
      tipo = fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "document";
    } else if (messageObj.photo && messageObj.photo.length > 0) {
      const bestPhoto = messageObj.photo[messageObj.photo.length - 1];
      fileId = bestPhoto.file_id;
      fileName = `Foto_${task.id}_${Date.now()}.jpg`;
      const sizeBytes = bestPhoto.file_size || 0;
      fileSizeStr = sizeBytes > 1024 * 1024 ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(sizeBytes / 1024) + " KB";
      tipo = "image";
    }

    let categoria = "Documentación de Soporte";
    const capLower = (captionText + " " + fileName).toLowerCase();
    if (capLower.includes("factura") || capLower.includes("ticket") || capLower.includes("nota") || capLower.includes("recibo")) {
      categoria = "Factura / Ticket";
    } else if (capLower.includes("recepcion") || capLower.includes("remision") || capLower.includes("entrega")) {
      categoria = "Hoja de Recepción";
    } else if (capLower.includes("sellado") || capLower.includes("oficio") || capLower.includes("permiso") || capLower.includes("acta")) {
      categoria = "Documentación Oficial Sellada";
    } else if (capLower.includes("comunicado") || capLower.includes("aviso") || capLower.includes("minuta")) {
      categoria = "Comunicado Oficial";
    } else if (tipo === "image") {
      categoria = "Fotografía de Campo";
    }

    const attachId = `ATT-${Date.now()}`;
    const targetFolder = path.join(DATA_DIR, 'adjuntos', task.id);
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
    const relativePath = `data/adjuntos/${task.id}/${fileName}`;
    const localFilePath = path.join(targetFolder, fileName);

    if (botToken && fileId) {
      downloadTelegramFile(botToken, fileId, localFilePath);
    }

    const newAttach = {
      id: attachId,
      taskId: task.id,
      name: fileName,
      categoria: categoria,
      tipo: tipo,
      tamano: fileSizeStr,
      fecha: new Date().toISOString(),
      autor: user.nombre,
      canal: "Telegram",
      url: relativePath,
      nota: captionText || undefined
    };
    addProjectAttachment(task.id, newAttach);

    const noteText = `📎 Adjuntó archivo de soporte: ${fileName} [${categoria}]${captionText ? ' — ' + captionText : ''}`;
    addProjectComment(task._projId, task.id, user.nombre, noteText);
    tryGitCommit(`feat(adjuntos): nuevo soporte ${fileName} en ${task.id} via Telegram [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `✅ *¡Archivo de soporte registrado y respaldado!*\n\n` +
            `📌 *Tarea:* \`${task.id}\`\n` +
            `📄 *Archivo:* \`${fileName}\`\n` +
            `🏷️ *Categoría:* ${categoria}\n` +
            `👤 *Subido por:* ${user.nombre}\n` +
            `📦 *Tamaño:* ${fileSizeStr}\n\n` +
            `_🐙 Respaldado en Git-as-a-Database y visible en el Centro de Operaciones Web._`
    };
  }

  // 3. Detección Inteligente de Intención (Crossref Engine)
  const intent = detectIntent(rawText);

  // 4. Si el usuario está en hilo activo de tarea:
  if (userSessions[from.id]) {
    // Si la intención es salir del hilo:
    if (intent.type === "SALIR_TAREA") {
      const prevTask = userSessions[from.id].activeTaskId;
      delete userSessions[from.id];
      return {
        authorized: true,
        text: `🔙 *Has salido del hilo de ${prevTask}.*\nAhora estás en el menú principal.\n\nEscribe *mis tareas*, *reporte* o *ayuda*.`,
        keyboard: [
          [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }]
        ]
      };
    }

    // Si escribió texto libre ordinario que no es ningún comando del sistema -> comentar en la tarea
    if (intent.type === "DESCONOCIDO") {
      const activeTaskId = userSessions[from.id].activeTaskId;
      const task = findTaskById(activeTaskId);
      if (task) {
        addProjectComment(task._projId, task.id, user.nombre, rawText);
        tryGitCommit(`feat(data): nuevo comentario en ${task.id} por ${user.nombre} via Telegram`, user);
        return {
          authorized: true,
          text: `💬 *Comentario publicado en ${task.id}:*\n\n"${rawText}"\n\n` +
                `👤 *Autor:* ${user.nombre}\n` +
                `_(Sigues en el hilo de ${task.id}. Envía /salir para terminar)_`,
          keyboard: [
            [{ text: "✅ Completar Tarea", callback_data: `completar_${task.id}` }, { text: "🚀 Iniciar Tarea", callback_data: `iniciar_${task.id}` }],
            [{ text: "🔙 Salir del Hilo", callback_data: "cmd_salir_tarea" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
          ]
        };
      }
    }
  }

  // 5. Ejecutar la intención detectada

  // A. Salir cuando no estaba en sesión de tarea
  if (intent.type === "SALIR_TAREA") {
    return {
      authorized: true,
      text: `ℹ️ Ya estás en el menú principal.\n\nEscribe *mis tareas*, *reporte* o pulsa los botones de abajo:`,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
        [{ text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // B. Entrar a modo tarea enfocada
  if (intent.type === "ENTRAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*. Escribe *mis tareas* para consultar tus entregables disponibles.`
      };
    }
    userSessions[from.id] = { activeTaskId: task.id };
    return {
      authorized: true,
      text: `💬 *Modo Conversación Activo: ${task.id}*\n` +
            `📝 *${task.name}*\n` +
            `👤 *Responsable:* ${task.responsable}\n` +
            `📊 *Estado:* ${task.estado} (${task.progress || 0}%)\n\n` +
            `Todos los mensajes o documentos de soporte (PDFs, facturas, remisiones) que envíes ahora se vincularán directamente a esta tarea.\n\n` +
            `👉 Escribe tu mensaje o envía una foto/archivo de soporte.\n` +
            `_(Para salir de este hilo, envía /salir o pulsa el botón abajo)_`,
      keyboard: [
        [{ text: "✅ Completar Tarea", callback_data: `completar_${task.id}` }, { text: "🚀 Iniciar Tarea", callback_data: `iniciar_${task.id}` }],
        [{ text: "🔙 Salir del Hilo", callback_data: "cmd_salir_tarea" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // C. Mis Tareas
  if (intent.type === "MIS_TAREAS") {
    const allTasks = getAllProjectTasks();
    const isMaster = user.alcanceEdicion === "todas";
    
    // Si es Web Master y no tiene tareas asignadas a su nombre exacto, mostrar todas las tareas activas
    let myTasks = allTasks.filter(t => {
      const resp = (t.responsable || "").toLowerCase();
      const uName = (user.nombre || "").toLowerCase();
      return resp.includes(uName) || uName.includes(resp);
    });

    if (myTasks.length === 0 && isMaster) {
      myTasks = allTasks.filter(t => t.estado !== "Completada");
    }

    if (myTasks.length === 0) {
      return {
        authorized: true,
        text: `📋 *Tus Tareas Asignadas (${user.nombre})*\n\nActualmente no tienes tareas pendientes asignadas.\nPuedes crear una nueva escribiendo:\n*crear [nombre de la tarea]*`,
        keyboard: [
          [{ text: "📊 Reporte", callback_data: "cmd_reporte" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
        ]
      };
    }

    let response = `📋 *Tareas Asignadas (${myTasks.length}):*\n\n`;
    const keyboard = [];

    myTasks.forEach((t) => {
      const icon = t.estado === "Completada" ? "✅" : (t.estado === "En Progreso" ? "⚡" : "⏳");
      response += `${icon} *${t.id}:* ${t.name}\n`;
      response += `   👤 ${t.responsable} | 📅 Límite: \`${t.end || "Sin fecha"}\`\n`;
      response += `   📊 Estado: *${t.estado}* (${t.progress || 0}%)\n\n`;

      const row = [];
      if (t.estado !== "Completada") {
        row.push({ text: `✅ Completar ${t.id}`, callback_data: `completar_${t.id}` });
        row.push({ text: `🚀 Iniciar ${t.id}`, callback_data: `iniciar_${t.id}` });
      }
      row.push({ text: `💬 Abrir ${t.id}`, callback_data: `tarea_${t.id}` });
      keyboard.push(row);
    });

    keyboard.push([{ text: "📊 Reporte General", callback_data: "cmd_reporte" }]);

    return {
      authorized: true,
      text: response.trim(),
      keyboard: keyboard.length > 0 ? keyboard : null
    };
  }

  // D. Completar Tarea (Regla de Propiedad Estricta)
  if (intent.type === "COMPLETAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*. Escribe *mis tareas* para consultar los identificadores disponibles.`
      };
    }

    const isOwner = (task.responsable || "").toLowerCase().includes((user.nombre || "").toLowerCase()) ||
                    (user.alcanceEdicion === "todas");

    if (!isOwner) {
      return {
        authorized: true,
        text: `⚠️ *Permiso denegado:*\nSolo el responsable asignado (*${task.responsable}*) puede modificar o completar esta tarea.`
      };
    }

    updateTaskStatus(task, "Completada", 100);
    tryGitCommit(`chore(data): completar ${task.id} via Telegram [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `✅ *¡Tarea completada con éxito!*\n\n` +
            `📌 *ID:* \`${task.id}\`\n` +
            `📝 *Nombre:* ${task.name}\n` +
            `👤 *Responsable:* ${user.nombre}\n` +
            `📊 *Estado:* Completada (100%)\n` +
            `🐙 *Registro:* Guardado en Git-as-a-Database y sincronizado con el Centro de Operaciones.`,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }]
      ]
    };
  }

  // E. Iniciar Tarea (Regla de Propiedad Estricta)
  if (intent.type === "INICIAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*. Escribe *mis tareas* para verificar tus IDs.`
      };
    }

    const isOwner = (task.responsable || "").toLowerCase().includes((user.nombre || "").toLowerCase()) ||
                    (user.alcanceEdicion === "todas");

    if (!isOwner) {
      return {
        authorized: true,
        text: `⚠️ *Permiso denegado:*\nSolo el responsable asignado (*${task.responsable}*) puede modificar o iniciar esta tarea.`
      };
    }

    updateTaskStatus(task, "En Progreso", 50);
    tryGitCommit(`chore(data): iniciar ${task.id} via Telegram [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `🚀 *Tarea puesta en progreso:*\n\n` +
            `📌 *ID:* \`${task.id}\`\n` +
            `📝 *Nombre:* ${task.name}\n` +
            `👤 *Responsable:* ${user.nombre}\n` +
            `📊 *Estado:* En Progreso (50%)\n` +
            `🐙 *Registro:* Sincronizado en GitHub.`,
      keyboard: [
        [{ text: `✅ Completar ${task.id}`, callback_data: `completar_${task.id}` }, { text: `💬 Abrir ${task.id}`, callback_data: `tarea_${task.id}` }],
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // F. Crear Nueva Tarea (Creación Universal & Auto-Asignación)
  if (intent.type === "CREAR_TAREA") {
    if (!intent.taskName) {
      return {
        authorized: true,
        text: `⚠️ Por favor especifica el nombre de la tarea.\nEjemplo: \`crear Instalar válvula de paso sector 2\``
      };
    }

    const result = createNewTask(intent.taskName, user.nombre);
    if (!result) {
      return {
        authorized: true,
        text: `❌ Ocurrió un error al crear la tarea en los archivos de GitHub.`
      };
    }

    tryGitCommit(`feat(data): crear ${result.task.id} asignada a ${user.nombre} via Telegram`, user);

    return {
      authorized: true,
      text: `📋 *¡Nueva tarea creada con éxito!*\n\n` +
            `📌 *ID WBS:* \`${result.task.id}\`\n` +
            `📝 *Nombre:* ${result.task.name}\n` +
            `👤 *Responsable:* *${user.nombre}* (Auto-asignada al creador)\n` +
            `📅 *Fecha Límite:* \`${result.task.end}\`\n` +
            `📊 *Estado:* No Iniciada\n\n` +
            `_🐙 Registrada en Git-as-a-Database y visible en el Centro de Operaciones._`,
      keyboard: [
        [{ text: `🚀 Iniciar ${result.task.id}`, callback_data: `iniciar_${result.task.id}` }, { text: `💬 Abrir ${result.task.id}`, callback_data: `tarea_${result.task.id}` }],
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // G. Comentar en Tarea
  if (intent.type === "COMENTAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}* para registrar el comentario.`
      };
    }

    addProjectComment(task._projId, task.id, user.nombre, intent.comment);
    tryGitCommit(`feat(data): nuevo comentario en ${task.id} por ${user.nombre} via Telegram`, user);

    return {
      authorized: true,
      text: `💬 *Comentario publicado en ${task.id}:*\n\n` +
            `"${intent.comment}"\n\n` +
            `👤 *Autor:* ${user.nombre} (${user.rol})\n` +
            `🌐 *Visibilidad:* Disponible de inmediato en el Centro de Operaciones Web y bitácora del proyecto.`,
      keyboard: [
        [{ text: `💬 Entrar a ${task.id}`, callback_data: `tarea_${task.id}` }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // H. Reporte de Salud y Costos
  if (intent.type === "REPORTE") {
    const allTasks = getAllProjectTasks();
    const total = allTasks.length;
    const completadas = allTasks.filter(t => t.estado === "Completada").length;
    const progreso = allTasks.filter(t => t.estado === "En Progreso").length;
    const pendientes = allTasks.filter(t => t.estado === "No Iniciada").length;
    const inversionTotal = allTasks.reduce((acc, t) => acc + (Number(t.costoTotal) || 0), 0);

    return {
      authorized: true,
      text: `📊 *Reporte Operativo del Proyecto Chimay*\n\n` +
            `📦 *Total de Tareas:* ${total}\n` +
            `✅ *Completadas:* ${completadas} (${total > 0 ? Math.round((completadas/total)*100) : 0}%)\n` +
            `⚡ *En Progreso:* ${progreso}\n` +
            `⏳ *Por Iniciar:* ${pendientes}\n` +
            `💰 *Presupuesto Total Comprometido:* $${inversionTotal.toLocaleString('es-MX')} MXN\n\n` +
            `🌐 Para ver el desglose jerárquico completo, abre el Centro de Operaciones Web.`,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // I. Menú Principal / Ayuda
  if (intent.type === "AYUDA") {
    return {
      authorized: true,
      text: `🤖 *Centro de Operaciones Chimay (Telegram)*\n` +
            `¡Hola *${user.nombre}*! (${user.rol})\n\n` +
            `Puedes gestionar tareas con los siguientes comandos:\n\n` +
            `📋 *mis tareas* ➔ Ver tus actividades asignadas y fechas límite.\n` +
            `✅ *completar [ID]* ➔ Marcar tu tarea como finalizada (ej. \`completar TSK-01\`).\n` +
            `🚀 *iniciar [ID]* ➔ Poner tu tarea en progreso (ej. \`iniciar TSK-01\`).\n` +
            `💬 *[ID]: [mensaje]* ➔ Chatear en cualquier tarea (ej. \`TSK-01: Ya instalamos los goteros\`).\n` +
            `➕ *crear [nombre]* ➔ Crear una nueva tarea (quedas asignado como responsable).\n` +
            `📊 *reporte* ➔ Resumen de estado de salud del proyecto.\n\n` +
            `_🔒 Regla de propiedad: Solo puedes modificar tareas asignadas a ti. Cualquier usuario puede chatear y crear tareas._`,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
        [{ text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // J. Mensaje por defecto si no reconoció el comando
  return {
    authorized: true,
    text: `🤖 No reconocí esa instrucción, *${user.nombre}*.\n\n` +
          `Pulsa un botón de abajo o escribe:\n` +
          `• *mis tareas* para ver tus entregables.\n` +
          `• *reporte* para el balance operativo.\n` +
          `• *ayuda* para la lista completa de comandos.`,
    keyboard: [
      [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
      [{ text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
    ]
  };
}

// Envío de mensaje vía Telegram Bot API
function sendTelegramResponse(botToken, chatId, messageObj) {
  if (!botToken || !chatId || !messageObj) return Promise.resolve(null);

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

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', err => reject(err));
    req.write(postData);
    req.end();
  });
}

// Procesar Update completo de Telegram (Webhook o Polling)
function handleTelegramUpdate(update, botToken = null) {
  let message = null;
  let isCallback = false;

  if (update.message) {
    message = update.message;
  } else if (update.callback_query) {
    isCallback = true;
    message = {
      from: update.callback_query.from,
      chat: update.callback_query.message ? update.callback_query.message.chat : { id: update.callback_query.from.id },
      text: update.callback_query.data.replace('_', ' ')
    };
  }

  if (!message) return null;

  const reply = processTelegramMessage(message.from, message.text, message, botToken);

  if (botToken && message.chat && message.chat.id) {
    sendTelegramResponse(botToken, message.chat.id, reply);
  }

  return reply;
}

// Modo Daemon / Polling para ejecución en terminal
async function startPollingDaemon(botToken) {
  if (!botToken) {
    console.error("❌ Se requiere TELEGRAM_BOT_TOKEN como variable de entorno.");
    process.exit(1);
  }

  console.log("🚀 Iniciando Bot de Telegram de Chimay en modo Long Polling...");
  console.log("📁 Repositorio:", REPO_ROOT);

  // Verificar estado del bot en Telegram (getMe)
  try {
    const meData = await new Promise((resolve) => {
      https.get(`https://api.telegram.org/bot${botToken}/getMe`, res => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false }); }
        });
      }).on('error', () => resolve({ ok: false }));
    });
    if (meData.ok && meData.result) {
      console.log(`✅ Bot conectado exitosamente como: @${meData.result.username} (${meData.result.first_name})`);
    } else {
      console.warn("⚠️ Aviso: Verificación de token devolvió:", meData.description || "Sin respuesta");
    }
  } catch (err) {
    console.warn("⚠️ No se pudo verificar getMe:", err.message);
  }

  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=30`;
      const updates = await new Promise((resolve, reject) => {
        https.get(url, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false }); }
          });
        }).on('error', err => resolve({ ok: false }));
      });

      if (updates.ok && Array.isArray(updates.result)) {
        for (const up of updates.result) {
          offset = up.update_id + 1;
          const result = handleTelegramUpdate(up, botToken);
          console.log(`[Update ${up.update_id}] Procesado:`, result ? result.text.substring(0, 50) + '...' : 'Vacio');
        }
      }
    } catch (e) {
      console.error("Error en ciclo de polling:", e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Exportar funciones para tests y serverless
module.exports = {
  authenticateTelegramUser,
  processTelegramMessage,
  handleTelegramUpdate,
  findTaskById,
  getAllProjectTasks,
  updateTaskStatus,
  createNewTask,
  addProjectComment,
  startPollingDaemon
};

// Si se ejecuta directamente desde CLI: node scripts/telegram_bot.js
if (require.main === module) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    startPollingDaemon(token);
  } else {
    console.log("ℹ️ Módulo cargado en modo librería. Para iniciar el bot de Telegram, define TELEGRAM_BOT_TOKEN.");
    console.log("Ejemplo: $env:TELEGRAM_BOT_TOKEN='tu_token_aqui'; node scripts/telegram_bot.js");
  }
}
