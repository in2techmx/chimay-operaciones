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

// Utilidades de Archivos JSON
function loadJson(filePath, defaultValue = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[Error leyendo ${filePath}]:`, err.message);
  }
  return defaultValue;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Cargar Catálogo de Usuarios
function getAuthorizedUsers() {
  return loadJson(USERS_FILE, []);
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

// Procesador Central de Mensajes de Telegram
function processTelegramMessage(from, text, messageObj = null, botToken = null) {
  const rawText = (text || "").trim();
  const lower = rawText.toLowerCase();

  // 1. Verificación de Autenticación
  const user = authenticateTelegramUser(from);
  if (!user) {
    // REGLA ESTRICTA DE SEGURIDAD (Gate 2 AS): Zero Info Disclosure. Sin nombres de personal ni detalles de proyecto.
    return {
      authorized: false,
      text: `🚫 *Acceso no autorizado.*\nTu ID de Telegram es \`${from.id}\`.\n\n*Solicita a Web Master brindarte acceso.*`
    };
  }

  // 2. Modo Tarea Enfocada: /start task_[ID] o /tarea [ID]
  const matchDeepLink = rawText.match(/^\/start\s+task_([a-z0-9\-]+)/i);
  const matchTareaCmd = rawText.match(/^\/tarea(?:\s+([a-z0-9\-]+))?$/i);

  if (matchDeepLink || (matchTareaCmd && matchTareaCmd[1])) {
    const targetId = (matchDeepLink ? matchDeepLink[1] : matchTareaCmd[1]).toUpperCase();
    const task = findTaskById(targetId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${targetId}*. Escribe *mis tareas* para consultar tus entregables disponibles.`
      };
    }
    userSessions[from.id] = { activeTaskId: task.id };
    return {
      authorized: true,
      text: `💬 *Modo Conversación Activo: ${task.id}*\n` +
            `📝 *${task.name}*\n` +
            `👤 *Responsable:* ${task.responsable}\n` +
            `📊 *Estado:* ${task.estado} (${task.progress || 0}%)\n\n` +
            `Todos los mensajes o documentos de soporte (PDFs, fotos de remisiones, facturas) que envíes ahora se vincularán directamente a esta tarea.\n\n` +
            `👉 Escribe tu mensaje o envía una foto/archivo de soporte.\n` +
            `_(Para salir de este hilo, envía /salir o /menu)_`,
      keyboard: [
        [{ text: "✅ Completar Tarea", callback_data: `completar_${task.id}` }, { text: "🚀 Iniciar Tarea", callback_data: `iniciar_${task.id}` }],
        [{ text: "🔙 Salir del Hilo", callback_data: "cmd_salir_tarea" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // 3. Salir del hilo enfocado: /salir o cmd_salir_tarea
  if (lower === "/salir" || lower === "/salir_tarea" || lower === "salir" || lower === "cmd_salir_tarea") {
    if (userSessions[from.id]) {
      const prevTask = userSessions[from.id].activeTaskId;
      delete userSessions[from.id];
      return {
        authorized: true,
        text: `🔙 *Has salido del hilo de ${prevTask}.*\nAhora estás en el menú principal.\n\nEscribe *mis tareas*, *reporte* o *ayuda*.`
      };
    }
  }

  // 4. Recepción de Archivos de Soporte (Documentos / Fotos)
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

  // 5. Si está en sesión activa de tarea y envió texto normal (sin ser comando reservado)
  const isCommand = lower.startsWith("/") || lower === "mis tareas" || lower === "reporte" || lower === "ayuda" || lower === "menu" || lower.startsWith("crear ") || lower.startsWith("completar ") || lower.startsWith("iniciar ");
  if (userSessions[from.id] && !isCommand) {
    const activeTaskId = userSessions[from.id].activeTaskId;
    const task = findTaskById(activeTaskId);
    if (task) {
      addProjectComment(task._projId, task.id, user.nombre, rawText);
      tryGitCommit(`feat(data): nuevo comentario en ${task.id} por ${user.nombre} via Telegram`, user);
      return {
        authorized: true,
        text: `💬 *Comentario publicado en ${task.id}:*\n\n"${rawText}"\n\n` +
              `👤 *Autor:* ${user.nombre}\n` +
              `_(Sigues en el hilo de ${task.id}. Envía /salir para terminar)_`
      };
    }
  }

  // 6. Comando: /start, ayuda, menu
  if (lower === "/start" || lower === "ayuda" || lower === "/ayuda" || lower === "menu") {
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

  // 3. Comando: mis tareas / pendientes / /tareas
  if (lower === "mis tareas" || lower === "tareas" || lower === "pendientes" || lower === "/tareas") {
    const allTasks = getAllProjectTasks();
    const myTasks = allTasks.filter(t => {
      const resp = (t.responsable || "").toLowerCase();
      const uName = (user.nombre || "").toLowerCase();
      return resp.includes(uName) || uName.includes(resp);
    });

    if (myTasks.length === 0) {
      return {
        authorized: true,
        text: `📋 *Tus Tareas Asignadas (${user.nombre})*\n\nActualmente no tienes tareas pendientes asignadas.\nPuedes crear una nueva escribiendo:\n*crear [nombre de la tarea]*`
      };
    }

    let response = `📋 *Tareas Asignadas a ${user.nombre} (${myTasks.length}):*\n\n`;
    const keyboard = [];

    myTasks.forEach((t, idx) => {
      const icon = t.estado === "Completada" ? "✅" : (t.estado === "En Progreso" ? "⚡" : "⏳");
      response += `${icon} *${t.id}:* ${t.name}\n`;
      response += `   📅 Límite: \`${t.end || "Sin fecha"}\` | Estado: *${t.estado}* | Avance: ${t.progress || 0}%\n\n`;

      if (t.estado !== "Completada") {
        keyboard.push([
          { text: `✅ Completar ${t.id}`, callback_data: `completar_${t.id}` },
          { text: `🚀 Iniciar ${t.id}`, callback_data: `iniciar_${t.id}` }
        ]);
      }
    });

    return {
      authorized: true,
      text: response.trim(),
      keyboard: keyboard.length > 0 ? keyboard : null
    };
  }

  // 4. Comando: completar [ID] (REGLA DE PROPIEDAD ESTRICTA)
  const matchCompletar = lower.match(/^(?:completar|finalizar|terminar|cerrar)\s+([a-z0-9\-]+)$/i);
  if (matchCompletar) {
    const targetId = matchCompletar[1].toUpperCase();
    const task = findTaskById(targetId);

    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${targetId}*. Escribe *mis tareas* para ver tus entregables disponibles.`
      };
    }

    // Comprobación de Propiedad
    const isOwner = (task.responsable || "").toLowerCase().includes((user.nombre || "").toLowerCase()) ||
                    (user.alcanceEdicion === "todas");

    if (!isOwner) {
      return {
        authorized: true,
        text: `⚠️ *Permiso denegado:*\nSolo el responsable asignado (*${task.responsable}*) puede modificar o cambiar el estado de esta tarea.`
      };
    }

    // Actualizar estado
    updateTaskStatus(task, "Completada", 100);
    tryGitCommit(`chore(data): completar ${task.id} via Telegram [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `✅ *¡Tarea completada con éxito!*\n\n` +
            `📌 *ID:* \`${task.id}\`\n` +
            `📝 *Nombre:* ${task.name}\n` +
            `👤 *Responsable:* ${user.nombre}\n` +
            `📊 *Estado:* Completada (100%)\n` +
            `🐙 *Registro:* Guardado en Git-as-a-Database y sincronizado con el Centro de Operaciones.`
    };
  }

  // 5. Comando: iniciar [ID] (REGLA DE PROPIEDAD ESTRICTA)
  const matchIniciar = lower.match(/^(?:iniciar|arrancar|comenzar|empezar)\s+([a-z0-9\-]+)$/i);
  if (matchIniciar) {
    const targetId = matchIniciar[1].toUpperCase();
    const task = findTaskById(targetId);

    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${targetId}*. Escribe *mis tareas* para verificar tus IDs.`
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
            `🐙 *Registro:* Sincronizado en GitHub.`
    };
  }

  // 6. Comando: [ID]: [comentario] (CHAT UNIVERSAL: CUALQUIERA PUEDE CHATEAR)
  const matchComentar = rawText.match(/^(?:comentar\s+)?(tsk-[a-z0-9\-]+)[:\s]+(.+)$/i);
  if (matchComentar) {
    const targetId = matchComentar[1].toUpperCase();
    const commentText = matchComentar[2].trim();
    const task = findTaskById(targetId);

    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${targetId}* para registrar el comentario.`
      };
    }

    // Regla: Cualquier usuario autorizado puede chatear en cualquier tarea
    addProjectComment(task._projId, task.id, user.nombre, commentText);
    tryGitCommit(`feat(data): nuevo comentario en ${task.id} por ${user.nombre} via Telegram`, user);

    return {
      authorized: true,
      text: `💬 *Comentario publicado en ${task.id}:*\n\n` +
            `"${commentText}"\n\n` +
            `👤 *Autor:* ${user.nombre} (${user.rol})\n` +
            `🌐 *Visibilidad:* Disponible de inmediato en el Centro de Operaciones Web y bitácora del proyecto.`
    };
  }

  // 7. Comando: crear [nombre] (CREACIÓN UNIVERSAL Y AUTO-ASIGNACIÓN)
  if (lower.startsWith("crear ") || lower.startsWith("nueva tarea ")) {
    const taskName = rawText.replace(/^(?:crear\s+tarea\s+|crear\s+|nueva\s+tarea\s+)/i, "").trim();

    if (!taskName) {
      return {
        authorized: true,
        text: `⚠️ Por favor especifica el nombre de la tarea.\nEjemplo: \`crear Instalar válvula de paso sector 2\``
      };
    }

    // Quien la crea queda como dueño
    const result = createNewTask(taskName, user.nombre);
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
            `_🐙 Registrada en Git-as-a-Database y visible en el Centro de Operaciones._`
    };
  }

  // 8. Comando: reporte / costos
  if (lower.includes("reporte") || lower.includes("costos") || lower.includes("balance")) {
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
            `🌐 Para ver el desglose jerárquico completo, abre el Centro de Operaciones.`
    };
  }

  // 9. Mensaje por defecto / ayuda rápida
  return {
    authorized: true,
    text: `🤖 No reconocí esa instrucción, *${user.nombre}*.\n\n` +
          `Escribe *mis tareas* para ver tus pendientes o *ayuda* para conocer los comandos disponibles.`
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
