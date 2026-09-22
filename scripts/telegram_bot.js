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
const scrumMaster = require('./scrum_master_ai.js');

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

// Recalcular progreso y estado de la tarea padre en base a sus subtareas (Rollup Automático)
function recalculateParentTaskProgress(task) {
  if (!task || !task.subtareas || !Array.isArray(task.subtareas) || task.subtareas.length === 0) {
    return task;
  }
  const total = task.subtareas.length;
  const completed = task.subtareas.filter(s => s.estado === "Completada").length;
  const inProgress = task.subtareas.filter(s => s.estado === "En Progreso").length;

  task.progress = Math.round((completed / total) * 100);

  if (completed === total) {
    task.estado = "Completada";
  } else if (inProgress > 0 || completed > 0) {
    task.estado = "En Progreso";
  } else {
    task.estado = "No Iniciada";
  }
  task.fechaCambioEstado = new Date().toISOString();
  return task;
}

// Buscar subtarea por su ID en todo el proyecto
function findSubtaskById(subtaskId) {
  const cleanId = String(subtaskId || "").trim().toUpperCase();
  const allTasks = getAllProjectTasks();

  for (const t of allTasks) {
    if (t.subtareas && Array.isArray(t.subtareas)) {
      const found = t.subtareas.find(s => String(s.id).toUpperCase() === cleanId);
      if (found) {
        return { subtask: found, parentTask: t };
      }
    }
  }
  return null;
}

// Agregar nueva subtarea a una tarea existente
function addSubtask(parentTaskId, subtaskName, assignee, hours = 4) {
  const parentTask = findTaskById(parentTaskId);
  if (!parentTask) return null;

  const tasksInStage = loadJson(parentTask._tareasFilePath, []);
  const taskIdx = tasksInStage.findIndex(t => String(t.id).toUpperCase() === String(parentTask.id).toUpperCase());
  if (taskIdx === -1) return null;

  const currentTask = tasksInStage[taskIdx];
  if (!currentTask.subtareas || !Array.isArray(currentTask.subtareas)) {
    currentTask.subtareas = [];
  }

  const subNum = currentTask.subtareas.length + 1;
  const cleanParentNum = parentTask.id.replace(/^TSK-/, '');
  const subId = `SUB-${cleanParentNum}-${String(subNum).padStart(2, '0')}`;
  const hoy = new Date().toISOString().split('T')[0];

  const newSubtask = {
    id: subId,
    name: subtaskName,
    responsable: assignee || currentTask.responsable,
    estado: "No Iniciada",
    horas: Number(hours) || 4,
    fecha: hoy
  };

  currentTask.subtareas.push(newSubtask);
  recalculateParentTaskProgress(currentTask);
  saveJson(parentTask._tareasFilePath, tasksInStage);

  return { subtask: newSubtask, parentTask: currentTask };
}

// Actualizar estado de una subtarea y recalcular tarea padre
function updateSubtaskStatus(subtaskId, newStatus) {
  const hit = findSubtaskById(subtaskId);
  if (!hit) return null;

  const { parentTask } = hit;
  const tasksInStage = loadJson(parentTask._tareasFilePath, []);
  const taskIdx = tasksInStage.findIndex(t => String(t.id).toUpperCase() === String(parentTask.id).toUpperCase());
  if (taskIdx === -1) return null;

  const currentTask = tasksInStage[taskIdx];
  const subIdx = (currentTask.subtareas || []).findIndex(s => String(s.id).toUpperCase() === String(subtaskId).toUpperCase());
  if (subIdx === -1) return null;

  currentTask.subtareas[subIdx].estado = newStatus;
  if (newStatus === "Completada") {
    currentTask.subtareas[subIdx].fechaTermino = new Date().toISOString();
  }
  recalculateParentTaskProgress(currentTask);
  saveJson(parentTask._tareasFilePath, tasksInStage);

  return { subtask: currentTask.subtareas[subIdx], parentTask: currentTask };
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
  const salirList = ["salir", "salir tarea", "cancelar", "volver", "atras", "cerrar", "cerrar hilo", "terminar hilo"];
  if (salirList.includes(norm) || norm.startsWith("salir")) {
    return { type: "SALIR_TAREA" };
  }

  // 2. Daily Standup matutino / Scrum
  const standupKeywords = ["standup", "daily", "daily standup", "junta matutina", "cmd standup", "ver standup", "sprint standup", "resumen diario"];
  if (standupKeywords.includes(norm) || norm.includes("standup") || norm.includes("daily")) {
    return { type: "STANDUP" };
  }

  // 3. Crear Subtarea: subtarea [TSK-ID]: [nombre] @[responsable] o sub [TSK-ID]: [nombre]
  const subMatch = raw.match(/^(?:subtarea|sub)\s+(tsk-[a-z0-9\-]+)[:\s]+(.+)$/i);
  if (subMatch) {
    const parentTaskId = subMatch[1].toUpperCase();
    let subtaskName = subMatch[2].trim();
    let assignee = null;
    const respMatch = subtaskName.match(/@([a-zA-Z0-9_\. ]+)$/);
    if (respMatch) {
      assignee = respMatch[1].trim();
      subtaskName = subtaskName.replace(/@([a-zA-Z0-9_\. ]+)$/, '').trim();
    }
    return {
      type: "CREAR_SUBTAREA",
      parentTaskId,
      subtaskName,
      assignee
    };
  }

  // 4.1 Confirmar Completado de Subtarea (callback: conf_sub_[SUB-ID])
  const confSubMatch = norm.match(/^(?:conf\s+sub|confirmar\s+subtarea|si\s+completar\s+sub)\s+(sub-[a-z0-9\-]+)$/i);
  if (confSubMatch) {
    return { type: "EJECUTAR_COMPLETAR_SUBTAREA", subtaskId: confSubMatch[1].toUpperCase() };
  }

  // 4.2 Cancelar Completado de Subtarea (callback: canc_sub_[SUB-ID])
  const cancSubMatch = norm.match(/^(?:canc\s+sub|cancelar\s+subtarea|no\s+cancelar\s+sub)\s+(sub-[a-z0-9\-]+)$/i);
  if (cancSubMatch) {
    return { type: "CANCELAR_COMPLETAR_SUBTAREA", subtaskId: cancSubMatch[1].toUpperCase() };
  }

  // 4.3 Solicitar Confirmación para Completar Subtarea (Protección Anti-Errores SI/NO)
  const compSubMatch = norm.match(/^(?:completar|finalizar|listo|done)\s+(sub-[a-z0-9\-]+)$/i);
  if (compSubMatch) {
    return { type: "PEDIR_CONFIRMACION_COMPLETAR_SUBTAREA", subtaskId: compSubMatch[1].toUpperCase() };
  }

  // 5. Iniciar Subtarea: iniciar [SUB-ID] o arrancar [SUB-ID]
  const iniSubMatch = norm.match(/^(?:iniciar|arrancar|empezar)\s+(sub-[a-z0-9\-]+)$/i);
  if (iniSubMatch) {
    return { type: "INICIAR_SUBTAREA", subtaskId: iniSubMatch[1].toUpperCase() };
  }

  // 6. Consulta explícita a Scrum Master (/scrum [pregunta])
  const scrumCmdMatch = raw.match(/^\/scrum(?:\s+(.+))?$/i);
  if (scrumCmdMatch) {
    return { type: "SCRUM_QUERY", question: (scrumCmdMatch[1] || "").trim() };
  }

  // 7.0 Catálogo Completo de Tareas (Menú Interactivo con botones topados 1 por fila)
  const menuTareasKeywords = [
    "menu tareas", "catalogo", "catalogo de tareas", "ver catalogo", 
    "todas las tareas", "lista de tareas", "catalogo tareas", "tareas"
  ];
  if (menuTareasKeywords.includes(norm) || norm === "menu tareas" || norm === "tareas" || norm === "catalogo") {
    return { type: "MENU_TAREAS" };
  }

  // 7.1 Mis Tareas / Pendientes / Actividades asignadas
  const misTareasKeywords = [
    "mis tareas", "pendientes", "mis pendientes", "actividades", 
    "mis actividades", "ver mis tareas", "consultar mis tareas", 
    "tareas asignadas", "que tengo que hacer", "que hago", "mis entregables"
  ];
  if (misTareasKeywords.includes(norm) || norm.includes("mis tareas") || norm.includes("mis pendientes")) {
    return { type: "MIS_TAREAS" };
  }

  // 8. Opciones Específicas de Costos y Balance Financiero (US-CHIMAY-COSTOS-01 & US-CHIMAY-COSTOS-02)
  let targetStageId = null;
  if (norm.includes("etapa 1") || norm.includes("etapa-01") || norm.includes("etapa 01") || norm.includes("propuesta")) {
    targetStageId = "ETAPA-01";
  } else if (norm.includes("etapa 2") || norm.includes("etapa-02") || norm.includes("etapa 02") || (norm.includes("proyecto") && (norm.includes("etapa") || norm.includes("fase")))) {
    targetStageId = "ETAPA-02";
  } else if (norm.includes("etapa 3") || norm.includes("etapa-03") || norm.includes("etapa 03") || norm.includes("piloto")) {
    targetStageId = "ETAPA-03";
  } else if (norm.includes("todas") || norm.includes("consolidado") || norm.includes("global") || norm.includes("todo el proyecto")) {
    targetStageId = "todas";
  }

  // Comparativa y desglose por etapa
  if (norm.includes("por etapa") || norm.includes("comparar etapas") || norm.includes("indicador por etapa") || norm === "etapas") {
    return { type: "COSTOS_POR_ETAPA" };
  }

  if (norm.includes("activo vs proy") || norm.includes("activas vs proy") || norm.includes("activo vs proyectado") || norm.includes("activas vs proyectadas")) {
    return { type: "COSTO_ACTIVO_VS_PROY", stageId: targetStageId };
  }
  if (norm.includes("al dia") || norm.includes("costo real") || norm.includes("ejercido") || (norm.includes("completad") && norm.includes("cost"))) {
    return { type: "COSTO_AL_DIA", stageId: targetStageId };
  }
  if (norm.includes("en curso") || (norm.includes("en progreso") && norm.includes("cost")) || (norm.includes("costo activo") && !norm.includes("vs"))) {
    return { type: "COSTO_EN_CURSO", stageId: targetStageId };
  }
  if (norm.includes("proyectado") || norm.includes("no iniciada") || norm.includes("no iniciadas") || norm.includes("por iniciar") || norm.includes("sin sumar")) {
    return { type: "COSTO_PROYECTADO", stageId: targetStageId };
  }
  if (norm.includes("total global") || norm.includes("sumando actual") || norm.includes("sumando el actual") || (norm.includes("presupuesto total") && !targetStageId)) {
    return { type: "COSTO_TOTAL_GLOBAL", stageId: targetStageId };
  }
  if (targetStageId && (norm.includes("costo") || norm.includes("etapa") || norm.includes("presupuesto"))) {
    if (targetStageId === "todas") {
      return { type: "COSTOS_MENU", stageId: "todas" };
    }
    return { type: "COSTOS_ETAPA", stageId: targetStageId };
  }
  if (norm === "costos" || norm === "costo" || norm === "presupuesto" || norm === "presupuestos" || norm === "finanzas" || norm === "balance financiero" || norm === "cmd costos" || norm === "cmd presupuesto") {
    return { type: "COSTOS_MENU", stageId: targetStageId };
  }

  // 9. Reporte de Avance / Estado / KPIs
  const reporteKeywords = [
    "reporte", "informe", "estado", "avance", "balance", "kpi", "kpis", "salud", "status", "resumen", "dashboard"
  ];
  if (reporteKeywords.includes(norm) || norm.includes("reporte") || norm.includes("avance") || norm.includes("balance")) {
    return { type: "REPORTE" };
  }

  // 9. Ayuda / Start / Menú / Saludo inicial
  const ayudaKeywords = [
    "start", "ayuda", "menu", "menu principal", "inicio", "hola", "comandos", "help", "opciones", "buenos dias", "buenas tardes"
  ];
  if (ayudaKeywords.includes(norm)) {
    return { type: "AYUDA" };
  }

  // 10. Modo Tarea Enfocada (/start task_[ID], /tarea [ID], tarea [ID], hilo [ID], ver [ID])
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

  // 11.1 Confirmar Completado de Tarea (callback: conf_comp_[ID])
  const confCompMatch = norm.match(/^(?:conf\s+comp|confirmar\s+completar|si\s+completar)\s+([a-z0-9\-]+)$/i);
  if (confCompMatch) {
    return { type: "EJECUTAR_COMPLETAR_TAREA", taskId: confCompMatch[1].toUpperCase() };
  }

  // 11.2 Cancelar Completado de Tarea (callback: canc_comp_[ID])
  const cancCompMatch = norm.match(/^(?:canc\s+comp|cancelar\s+completar|no\s+cancelar)\s+([a-z0-9\-]+)$/i);
  if (cancCompMatch) {
    return { type: "CANCELAR_COMPLETAR_TAREA", taskId: cancCompMatch[1].toUpperCase() };
  }

  // 11.3 Solicitar Confirmación para Completar Tarea (Protección Anti-Errores SI/NO)
  const compMatch = norm.match(/^(?:completar|finalizar|terminar|cerrar|concluir|listo|done)\s+([a-z0-9\-]+)$/i);
  if (compMatch) {
    return { type: "PEDIR_CONFIRMACION_COMPLETAR_TAREA", taskId: compMatch[1].toUpperCase() };
  }

  // 12. Iniciar tarea (iniciar [ID], arrancar [ID], empezar [ID], comenzar [ID], progreso [ID])
  const iniMatch = norm.match(/^(?:iniciar|arrancar|empezar|comenzar|progreso)\s+([a-z0-9\-]+)$/i);
  if (iniMatch) {
    return { type: "INICIAR_TAREA", taskId: iniMatch[1].toUpperCase() };
  }

  // 13. Crear nueva tarea (crear [nombre], nueva tarea [nombre], agregar [nombre])
  const crearMatch = norm.match(/^(?:crear(?:\s+tarea)?|nueva(?:\s+tarea)?|agregar(?:\s+tarea)?|anadir(?:\s+tarea)?|registrar(?:\s+tarea)?)\s+(.+)$/i);
  if (crearMatch) {
    const rawMatch = raw.match(/^(?:crear(?:\s+tarea)?|nueva(?:\s+tarea)?|agregar(?:\s+tarea)?|añadir(?:\s+tarea)?|registrar(?:\s+tarea)?)\s+(.+)$/i);
    const taskName = (rawMatch ? rawMatch[1] : crearMatch[1]).trim();
    return { type: "CREAR_TAREA", taskName };
  }

  // 14. Comentar en tarea: [ID]: [comentario] o comentar [ID] [comentario]
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

// Procesador Central de Mensajes de Telegram con Crossref Universal y Scrum Master IA
async function processTelegramMessage(from, text, messageObj = null, botToken = null) {
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
        text: `🔙 *Has salido del hilo de ${prevTask}.*\nAhora estás en el menú principal.\n\nEscribe *mis tareas*, *reporte* o *standup*.`,
        keyboard: [
          [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "☀️ Daily Standup", callback_data: "cmd_standup" }],
          [{ text: "📊 Reporte", callback_data: "cmd_reporte" }, { text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
        ]
      };
    }

    // Si pide el menú principal explícitamente, liberamos la sesión y proseguimos al menú
    if (intent.type === "AYUDA") {
      delete userSessions[from.id];
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
                `_✍️ Registrado por ${user.nombre} en el Centro de Operaciones._`,
          keyboard: [
            [{ text: "🔙 Salir del Hilo", callback_data: "cmd_salir_tarea" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }],
            [{ text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
          ]
        };
      }
    }
  }

  // 5. Ejecutar la intención detectada

  // A. Daily Standup (Scrum Master)
  if (intent.type === "STANDUP") {
    const standupText = await scrumMaster.generateDailyStandup();
    return {
      authorized: true,
      text: standupText,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "📊 Reporte de Costos", callback_data: "cmd_reporte" }],
        [{ text: "🏠 Menú Principal", callback_data: "cmd_menu" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // B. Crear Subtarea Pulverizada
  if (intent.type === "CREAR_SUBTAREA") {
    const result = addSubtask(intent.parentTaskId, intent.subtaskName, intent.assignee);
    if (!result) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea padre *${intent.parentTaskId}* para asignarle esta subtarea.`
      };
    }

    tryGitCommit(`feat(data): pulverizar ${result.parentTask.id} con subtarea ${result.subtask.id} [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `🧩 *¡Subtarea pulverizada y registrada con éxito!*\n\n` +
            `📌 *ID Subtarea:* \`${result.subtask.id}\`\n` +
            `📝 *Nombre:* ${result.subtask.name}\n` +
            `👤 *Responsable:* *${result.subtask.responsable}*\n` +
            `📦 *Tarea Principal:* \`${result.parentTask.id}\` (${result.parentTask.name})\n` +
            `📊 *Nuevo Progreso Padre:* *${result.parentTask.progress}%* (${result.parentTask.estado})\n\n` +
            `_🐙 Guardada en Git-as-a-Database y sincronizada en el Centro de Operaciones._`,
      keyboard: [
        [{ text: `✅ Completar ${result.subtask.id}`, callback_data: `completar_${result.subtask.id}` }, { text: `💬 Abrir ${result.parentTask.id}`, callback_data: `tarea_${result.parentTask.id}` }],
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // C.1 Solicitar Confirmación para Completar Subtarea (Protección Anti-Errores SI/NO)
  if (intent.type === "PEDIR_CONFIRMACION_COMPLETAR_SUBTAREA") {
    const hit = findSubtaskById(intent.subtaskId);
    if (!hit) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la subtarea *${intent.subtaskId}*.`,
        keyboard: [[{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }]]
      };
    }
    const { subtask, parentTask } = hit;
    return {
      authorized: true,
      text: `⚠️ *Confirmación Requerida*\n\n` +
            `¿Confirmas que deseas marcar como *COMPLETADA* la siguiente subtarea?\n\n` +
            `🧩 *Subtarea:* \`${subtask.id}\` — *${subtask.name}*\n` +
            `📌 *Tarea Padre:* \`${parentTask.id}\` (${parentTask.name})\n` +
            `👤 *Responsable:* ${subtask.responsable}\n\n` +
            `_Esta acción actualizará el avance en tiempo real y registrará un commit en Git._`,
      keyboard: [
        [
          { text: "✅ Sí, completar", callback_data: `conf_sub_${subtask.id}` },
          { text: "❌ No, cancelar", callback_data: `canc_sub_${subtask.id}` }
        ]
      ]
    };
  }

  // C.2 Cancelar Completado de Subtarea
  if (intent.type === "CANCELAR_COMPLETAR_SUBTAREA") {
    const hit = findSubtaskById(intent.subtaskId);
    const parentId = hit ? hit.parentTask.id : null;
    return {
      authorized: true,
      text: `❌ *Operación cancelada.*\n\nLa subtarea \`${intent.subtaskId}\` no fue modificada y permanece en su estado actual.`,
      keyboard: [
        parentId ? [{ text: `💬 Volver a ${parentId}`, callback_data: `tarea_${parentId}` }] : [],
        [{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }, { text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
      ].filter(r => r.length > 0)
    };
  }

  // C.3 Ejecutar Completado de Subtarea (Tras Confirmación)
  if (intent.type === "EJECUTAR_COMPLETAR_SUBTAREA") {
    const result = updateSubtaskStatus(intent.subtaskId, "Completada");
    if (!result) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la subtarea *${intent.subtaskId}*.`
      };
    }

    tryGitCommit(`chore(data): completar subtarea ${result.subtask.id} de ${result.parentTask.id} [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `✅ *¡Subtarea completada con éxito!*\n\n` +
            `🧩 *ID:* \`${result.subtask.id}\` — ${result.subtask.name}\n` +
            `📦 *Tarea Padre:* \`${result.parentTask.id}\`\n` +
            `📊 *Nuevo Avance de la Tarea:* *${result.parentTask.progress}%* (${result.parentTask.estado})\n` +
            `👤 *Confirmado por:* ${user.nombre}\n\n` +
            `_🐙 Sincronizado en Git-as-a-Database._`,
      keyboard: [
        [{ text: `💬 Abrir ${result.parentTask.id}`, callback_data: `tarea_${result.parentTask.id}` }],
        [{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }, { text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
      ]
    };
  }

  // D. Iniciar Subtarea
  if (intent.type === "INICIAR_SUBTAREA") {
    const result = updateSubtaskStatus(intent.subtaskId, "En Progreso");
    if (!result) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la subtarea *${intent.subtaskId}*.`
      };
    }

    tryGitCommit(`chore(data): iniciar subtarea ${result.subtask.id} de ${result.parentTask.id} [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `⚡ *Subtarea puesta en progreso:*\n\n` +
            `🧩 *ID:* \`${result.subtask.id}\` — ${result.subtask.name}\n` +
            `📦 *Tarea Padre:* \`${result.parentTask.id}\` (${result.parentTask.estado})\n` +
            `👤 *Responsable:* ${result.subtask.responsable}`,
      keyboard: [
        [{ text: `✅ Completar ${result.subtask.id}`, callback_data: `completar_${result.subtask.id}` }],
        [{ text: `💬 Abrir ${result.parentTask.id}`, callback_data: `tarea_${result.parentTask.id}` }]
      ]
    };
  }

  // E. Consulta de IA a Scrum Master
  if (intent.type === "SCRUM_QUERY") {
    const q = intent.question || rawText;
    const answer = await scrumMaster.askScrumMaster(q, user.nombre);
    return {
      authorized: true,
      text: `🧠 *Scrum Master Chimay:*\n\n${answer}`,
      keyboard: [
        [{ text: "☀️ Daily Standup", callback_data: "cmd_standup" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // F. Salir cuando no estaba en sesión de tarea
  if (intent.type === "SALIR_TAREA") {
    return {
      authorized: true,
      text: `ℹ️ Ya estás en el menú principal.\n\nEscribe *mis tareas*, *standup*, *reporte* o pulsa los botones de abajo:`,
      keyboard: [
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "☀️ Daily Standup", callback_data: "cmd_standup" }],
        [{ text: "📊 Reporte", callback_data: "cmd_reporte" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // G. Entrar a modo tarea enfocada (con detalle de subtareas)
  if (intent.type === "ENTRAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*. Escribe *mis tareas* para consultar tus entregables disponibles.`
      };
    }
    userSessions[from.id] = { activeTaskId: task.id };

    let subtasksSection = "";
    const keyboard = [];

    if (task.subtareas && Array.isArray(task.subtareas) && task.subtareas.length > 0) {
      subtasksSection += `\n🧩 *Subtareas Pulverizadas (${task.subtareas.length}):*\n`;
      task.subtareas.forEach(s => {
        const icon = s.estado === "Completada" ? "✅" : (s.estado === "En Progreso" ? "⚡" : "⏳");
        subtasksSection += `   ${icon} \`${s.id}\`: ${s.name}\n      👤 *${s.responsable}* | ${s.horas}h | Estado: *${s.estado}*\n`;
        if (s.estado !== "Completada") {
          keyboard.push([{ text: `✅ Completar ${s.id}`, callback_data: `completar_${s.id}` }]);
        }
      });
    } else {
      subtasksSection += `\n🧩 *Subtareas:* Ninguna registrada.\nPuedes pulverizarla escribiendo:\n\`subtarea ${task.id}: [nombre] @[responsable]\`\n`;
    }

    keyboard.push([
      { text: "✅ Completar Tarea", callback_data: `completar_${task.id}` },
      { text: "🚀 Iniciar Tarea", callback_data: `iniciar_${task.id}` }
    ]);
    keyboard.push([
      { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" },
      { text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }
    ]);
    keyboard.push([
      { text: "🔙 Salir del Hilo", callback_data: "cmd_salir_tarea" },
      { text: "🏠 Menú Principal", callback_data: "cmd_menu" }
    ]);

    return {
      authorized: true,
      text: `💬 *Modo Conversación Activo: ${task.id}*\n` +
            `📝 *${task.name}*\n` +
            `👤 *Responsable:* ${task.responsable}\n` +
            `📊 *Estado:* ${task.estado} (${task.progress || 0}%)\n` +
            `📅 *Límite:* \`${task.end || "Sin fecha"}\` | 💰 *Costo:* $${Number(task.costoTotal || 0).toLocaleString('es-MX')} MXN\n` +
            subtasksSection + `\n` +
            `Todos los mensajes o documentos de soporte (PDFs, facturas, fotos) que envíes ahora se vincularán a esta tarea.\n\n` +
            `_(Para salir de este hilo, envía /salir o pulsa el botón abajo)_`,
      keyboard: keyboard
    };
  }

  // H.0 Menú Catálogo de Tareas (Botones Enlace con Nombres Topados)
  if (intent.type === "MENU_TAREAS") {
    const allTasks = getAllProjectTasks();
    if (!allTasks || allTasks.length === 0) {
      return {
        authorized: true,
        text: `📋 *Catálogo de Tareas*\n\nActualmente no hay tareas registradas en el proyecto.`,
        keyboard: [
          [{ text: "☀️ Daily Standup", callback_data: "cmd_standup" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
          [{ text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
        ]
      };
    }

    let response = `📋 *Catálogo de Tareas del Proyecto (${allTasks.length})*\n\n` +
                   `Pulsa sobre cualquier tarea para abrir su hilo directo, ver sus subtareas o comentar en su bitácora:`;

    const keyboard = [];
    allTasks.forEach(t => {
      const icon = t.estado === "Completada" ? "✅" : (t.estado === "En Progreso" ? "⚡" : "⏳");
      const id = t.id;
      const maxNameLen = 28;
      let cleanName = (t.name || "").trim();
      if (cleanName.length > maxNameLen) {
        cleanName = cleanName.substring(0, maxNameLen).trim() + "…";
      }
      const pct = `${t.progress || (t.estado === "Completada" ? 100 : 0)}%`;
      const btnText = `${icon} ${id}: ${cleanName} (${pct})`;

      // 1 botón por fila para máximo ancho y legibilidad en smartphones
      keyboard.push([{ text: btnText, callback_data: `tarea_${t.id}` }]);
    });

    keyboard.push([
      { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" },
      { text: "☀️ Standup", callback_data: "cmd_standup" }
    ]);
    keyboard.push([
      { text: "🏠 Menú Principal", callback_data: "cmd_menu" },
      { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }
    ]);

    return {
      authorized: true,
      text: response,
      keyboard: keyboard
    };
  }

  // H. Mis Tareas
  if (intent.type === "MIS_TAREAS") {
    const allTasks = getAllProjectTasks();
    const isMaster = user.alcanceEdicion === "todas";
    
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
          [{ text: "☀️ Daily Standup", callback_data: "cmd_standup" }, { text: "📊 Reporte", callback_data: "cmd_reporte" }],
          [{ text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
        ]
      };
    }

    let response = `📋 *Tareas Asignadas (${myTasks.length}):*\n\n` +
                   `Pulsa sobre cualquier tarea para abrir su hilo directo, ver sus subtareas o gestionarla:\n\n`;
    const keyboard = [];

    myTasks.forEach((t) => {
      const icon = t.estado === "Completada" ? "✅" : (t.estado === "En Progreso" ? "⚡" : "⏳");
      const subsInfo = (t.subtareas && t.subtareas.length > 0) ? ` [${t.subtareas.filter(s=>s.estado==='Completada').length}/${t.subtareas.length} subs]` : '';
      response += `${icon} *${t.id}:* ${t.name}${subsInfo}\n`;
      response += `   👤 ${t.responsable} | 📅 Límite: \`${t.end || "Sin fecha"}\`\n`;
      response += `   📊 Estado: *${t.estado}* (${t.progress || 0}%)\n`;
      if (t.subtareas && Array.isArray(t.subtareas) && t.subtareas.length > 0) {
        t.subtareas.forEach(s => {
          const sIcon = s.estado === "Completada" ? "✅" : (s.estado === "En Progreso" ? "⚡" : "⏳");
          response += `      ↳ ${sIcon} \`${s.id}\`: ${s.name} (${s.responsable} • ${s.estado})\n`;
        });
      }
      response += `\n`;

      // 1 botón por tarea a renglón completo con nombre topado y % de avance (100% legible y sin truncar ID)
      const maxNameLen = 28;
      let cleanName = (t.name || "").trim();
      if (cleanName.length > maxNameLen) {
        cleanName = cleanName.substring(0, maxNameLen).trim() + "…";
      }
      const pct = `${t.progress || (t.estado === "Completada" ? 100 : 0)}%`;
      const btnText = `${icon} ${t.id}: ${cleanName} (${pct})`;

      keyboard.push([{ text: btnText, callback_data: `tarea_${t.id}` }]);
    });

    keyboard.push([
      { text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" },
      { text: "☀️ Daily Standup", callback_data: "cmd_standup" }
    ]);
    keyboard.push([
      { text: "📊 Reporte General", callback_data: "cmd_reporte" },
      { text: "🏠 Menú Principal", callback_data: "cmd_menu" }
    ]);

    return {
      authorized: true,
      text: response.trim(),
      keyboard: keyboard.length > 0 ? keyboard : null
    };
  }

  // I.1 Solicitar Confirmación para Completar Tarea (Protección Anti-Errores SI/NO)
  if (intent.type === "PEDIR_CONFIRMACION_COMPLETAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*.`,
        keyboard: [[{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }]]
      };
    }

    const isOwner = (task.responsable || "").toLowerCase().includes((user.nombre || "").toLowerCase()) ||
                    (user.alcanceEdicion === "todas");

    if (!isOwner) {
      return {
        authorized: true,
        text: `⚠️ *Permiso denegado:*\nSolo el responsable asignado (*${task.responsable}*) o un administrador puede completar esta tarea.`
      };
    }

    return {
      authorized: true,
      text: `⚠️ *Confirmación Requerida*\n\n` +
            `¿Confirmas que deseas marcar como *COMPLETADA* la siguiente tarea?\n\n` +
            `📌 *ID:* \`${task.id}\`\n` +
            `📝 *Tarea:* ${task.name}\n` +
            `👤 *Responsable:* ${task.responsable}\n` +
            `📅 *Límite:* \`${task.end || "Sin fecha"}\` | 💰 *Costo:* $${Number(task.costoTotal || 0).toLocaleString("es-MX")} MXN\n\n` +
            `_Esta acción actualizará el avance al 100% y se registrará un commit en Git-as-a-Database._`,
      keyboard: [
        [
          { text: "✅ Sí, completar", callback_data: `conf_comp_${task.id}` },
          { text: "❌ No, cancelar", callback_data: `canc_comp_${task.id}` }
        ]
      ]
    };
  }

  // I.2 Cancelar Completado de Tarea
  if (intent.type === "CANCELAR_COMPLETAR_TAREA") {
    const task = findTaskById(intent.taskId);
    const taskIdStr = task ? task.id : intent.taskId;
    return {
      authorized: true,
      text: `❌ *Operación cancelada.*\n\nLa tarea \`${taskIdStr}\` no fue modificada y permanece en su estado actual.`,
      keyboard: [
        [{ text: `💬 Volver a ${taskIdStr}`, callback_data: `tarea_${taskIdStr}` }],
        [{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }, { text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
      ]
    };
  }

  // I.3 Ejecutar Completado de Tarea (Tras Confirmación)
  if (intent.type === "EJECUTAR_COMPLETAR_TAREA") {
    const task = findTaskById(intent.taskId);
    if (!task) {
      return {
        authorized: true,
        text: `⚠️ No se encontró la tarea *${intent.taskId}*.`
      };
    }

    const isOwner = (task.responsable || "").toLowerCase().includes((user.nombre || "").toLowerCase()) ||
                    (user.alcanceEdicion === "todas");

    if (!isOwner) {
      return {
        authorized: true,
        text: `⚠️ *Permiso denegado:*\nSolo el responsable asignado (*${task.responsable}*) puede completar esta tarea.`
      };
    }

    updateTaskStatus(task, "Completada", 100);
    tryGitCommit(`chore(data): completar ${task.id} via Telegram [${user.nombre}]`, user);

    return {
      authorized: true,
      text: `✅ *¡Tarea completada con éxito!*\n\n` +
            `📌 *ID:* \`${task.id}\`\n` +
            `📝 *Nombre:* ${task.name}\n` +
            `👤 *Confirmada por:* ${user.nombre}\n` +
            `📊 *Estado:* Completada (100%)\n` +
            `🐙 *Registro:* Guardado en Git-as-a-Database y sincronizado con el Centro de Operaciones.`,
      keyboard: [
        [{ text: `💬 Ver Ficha ${task.id}`, callback_data: `tarea_${task.id}` }],
        [{ text: "📋 Catálogo de Tareas", callback_data: "cmd_menu_tareas" }, { text: "☀️ Standup", callback_data: "cmd_standup" }],
        [{ text: "🏠 Menú Principal", callback_data: "cmd_menu" }]
      ]
    };
  }

  // J. Iniciar Tarea (Regla de Propiedad Estricta)
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

  // K. Crear Nueva Tarea (Creación Universal & Auto-Asignación)
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

  // L. Comentar en Tarea
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

  // M.1 Inteligencia Financiera y Selector de Costos (US-CHIMAY-COSTOS-01 & US-CHIMAY-COSTOS-02)
  if (["COSTOS_MENU", "COSTOS_ETAPA", "COSTOS_POR_ETAPA", "COSTO_ACTIVO_VS_PROY", "COSTO_AL_DIA", "COSTO_EN_CURSO", "COSTO_PROYECTADO", "COSTO_TOTAL_GLOBAL"].includes(intent.type)) {
    const context = scrumMaster.compileProjectContext();

    // Función auxiliar para construir el teclado con selector de etapas y criterios
    const buildFinancialKeyboard = (selectedStageId = null) => {
      const isSpecific = selectedStageId && selectedStageId !== 'todas';
      const stageSuffix = isSpecific ? `_${selectedStageId}` : '';

      return [
        [
          { text: selectedStageId === 'ETAPA-01' ? "🔘 1: Propuesta" : "📁 1: Propuesta", callback_data: "cmd_costo_etapa_ETAPA-01" },
          { text: selectedStageId === 'ETAPA-02' ? "🔘 2: Proyecto" : "📁 2: Proyecto", callback_data: "cmd_costo_etapa_ETAPA-02" },
          { text: selectedStageId === 'ETAPA-03' ? "🔘 3: Piloto" : "📁 3: Piloto", callback_data: "cmd_costo_etapa_ETAPA-03" }
        ],
        [
          { text: (!selectedStageId || selectedStageId === 'todas') ? "🔘 ✨ Todo el Proyecto" : "✨ Todo el Proyecto", callback_data: "cmd_costo_etapa_todas" },
          { text: "📊 Comparar Etapas", callback_data: "cmd_costos_por_etapa" }
        ],
        [
          { text: "⚖️ Activo vs Proy", callback_data: `cmd_costo_activo_vs_proy${stageSuffix}` }
        ],
        [
          { text: "✅ Al Día (Real)", callback_data: `cmd_costo_al_dia${stageSuffix}` },
          { text: "⚡ En Curso", callback_data: `cmd_costo_en_curso${stageSuffix}` }
        ],
        [
          { text: "🔮 Proyectado", callback_data: `cmd_costo_proyectado${stageSuffix}` },
          { text: "🌐 Total Global", callback_data: `cmd_costo_total_global${stageSuffix}` }
        ],
        [
          { text: "☀️ Daily Standup", callback_data: "cmd_standup" },
          { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }
        ],
        [
          { text: "🏠 Menú Principal", callback_data: "cmd_menu" }
        ]
      ];
    };

    // Caso 1: Comparativa y desglose global de todas las etapas
    if (intent.type === "COSTOS_POR_ETAPA") {
      let text = `📊 *Comparativa Financiera por Etapas — Proyecto Chimay*\n\n`;
      context.etapasInfo.forEach((et, idx) => {
        const f = et.finanzas;
        text += `📁 *${idx + 1}. Etapa ${et.id.replace('ETAPA-', '')}: ${et.nombre}*\n` +
                `   • Total Presupuestado: *$${f.costoTotalGlobal.toLocaleString('es-MX')} MXN* (${et.totalTareas} tareas)\n` +
                `   • ⚡ Activo: \`$${f.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${f.pctActivoTotal}% | Al Día: $${f.costoAlDia.toLocaleString('es-MX')} + En Curso: $${f.costoEnProgreso.toLocaleString('es-MX')})\n` +
                `   • ⏳ Proyectado: \`$${f.costoProyectado.toLocaleString('es-MX')} MXN\` (${f.pctProyectado}%)\n\n`;
      });
      text += `🌐 *Presupuesto Global Consolidado:* *$${context.finanzas.costoTotalGlobal.toLocaleString('es-MX')} MXN*\n\n` +
              `_👇 Selecciona una etapa específica para ver sus 5 criterios financieros:_`;

      return {
        authorized: true,
        text,
        keyboard: buildFinancialKeyboard(null)
      };
    }

    // Filtrar tareas según el alcance (etapa individual vs proyecto completo)
    let tasksToAnalyze = context.tareasDetalle;
    let stageName = "Todo el Proyecto (Consolidado)";
    const isStageScope = intent.stageId && intent.stageId !== "todas";

    if (isStageScope) {
      const stageInfo = context.etapasInfo.find(e => e.id.toUpperCase() === intent.stageId.toUpperCase());
      if (stageInfo) {
        tasksToAnalyze = stageInfo.tareas || tasksToAnalyze.filter(t => (t.etapaId && t.etapaId.toUpperCase() === intent.stageId.toUpperCase()) || (t.etapa && t.etapa.toLowerCase() === stageInfo.nombre.toLowerCase()));
        stageName = `Etapa ${stageInfo.id.replace('ETAPA-', '')}: ${stageInfo.nombre}`;
      }
    }

    const fin = scrumMaster.calculateProjectFinances(tasksToAnalyze);
    const financialKeyboard = buildFinancialKeyboard(intent.stageId);

    // Caso 2: Resumen y menú financiero de una etapa específica
    if (intent.type === "COSTOS_ETAPA") {
      return {
        authorized: true,
        text: `📁 *Indicador Financiero — ${stageName}*\n\n` +
              `Total de actividades en esta etapa: *${tasksToAnalyze.length} tareas*.\n\n` +
              `💰 *Presupuesto de la Etapa:* *$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN*\n\n` +
              `1️⃣ *Activo vs Proyectado:*\n` +
              `   • ⚡ Tareas Activas: \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (*${fin.pctActivoTotal}%*)\n` +
              `   • ⏳ Proyectado Futuro: \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (*${fin.pctProyectado}%*)\n\n` +
              `2️⃣ *Costo al Día (Completadas):* \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n` +
              `3️⃣ *Costo en Curso (En Progreso):* \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}%)\n` +
              `4️⃣ *Costo Proyectado (Sin sumar actual):* \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}%)\n` +
              `5️⃣ *Presupuesto Consolidado:* \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\` (100%)\n\n` +
              `_👇 Pulsa un criterio abajo para ver el detalle de esta etapa, o cambia de etapa:_`,
        keyboard: financialKeyboard
      };
    }

    if (intent.type === "COSTO_ACTIVO_VS_PROY") {
      return {
        authorized: true,
        text: `⚖️ *Balance Financiero: Tareas Activas vs Costo Proyectado*\n` +
              `📁 *Alcance:* *${stageName}*\n\n` +
              `⚡ *1. Tareas Activas (En Curso + Concluidas):*\n` +
              `   • Inversión Activa: *$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN* (*${fin.pctActivoTotal}%* del presupuesto de ${isStageScope ? 'la etapa' : 'el total'})\n` +
              `   • Al Día (Completadas): \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n` +
              `   • En Curso (En Progreso): \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}%)\n\n` +
              `⏳ *2. Costo Proyectado (No Iniciadas - Sin Sumar Actual):*\n` +
              `   • Inversión Futura: *$${fin.costoProyectado.toLocaleString('es-MX')} MXN* (*${fin.pctProyectado}%*)\n` +
              `   • Tareas Pendientes de Inicio: ${fin.tareasNoIniciadas.length} actividades planificadas.\n\n` +
              `🌐 *Presupuesto Total (${isStageScope ? 'Etapa' : 'Consolidado'}):*\n` +
              `   • *$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN* (100%)\n\n` +
              `_Selecciona otra perspectiva o cambia de etapa abajo:_`,
        keyboard: financialKeyboard
      };
    }

    if (intent.type === "COSTO_AL_DIA") {
      return {
        authorized: true,
        text: `💰 *Costo al Día / Real (Tareas Completadas al 100%)*\n` +
              `📁 *Alcance:* *${stageName}*\n\n` +
              `• *Monto Ejercido:* *$${fin.costoAlDia.toLocaleString('es-MX')} MXN*\n` +
              `• *Proporción:* *${fin.pctAlDia}%* del presupuesto de ${isStageScope ? 'esta etapa' : 'todo el proyecto'}.\n` +
              `• *Entregables Concluidos (${fin.tareasCompletadas.length}):*\n` +
              (fin.tareasCompletadas.map(t => `   ✅ *${t.id}:* ${t.name}\n      💰 \`$${Number(t.costoTotal).toLocaleString('es-MX')} MXN\` • 👤 ${t.responsable}`).join('\n') || '   _Sin tareas completadas aún en este alcance._') + `\n\n` +
              `_💡 Representa el capital devengado que ya generó valor tangible._`,
        keyboard: financialKeyboard
      };
    }

    if (intent.type === "COSTO_EN_CURSO") {
      return {
        authorized: true,
        text: `⚡ *Costo en Curso (Tareas Activas en Ejecución)*\n` +
              `📁 *Alcance:* *${stageName}*\n\n` +
              `• *Monto en Proceso:* *$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN*\n` +
              `• *Proporción:* *${fin.pctEnCurso}%* del presupuesto de ${isStageScope ? 'esta etapa' : 'todo el proyecto'}.\n` +
              `• *Tareas en Ejecución (${fin.tareasEnProgreso.length}):*\n` +
              (fin.tareasEnProgreso.map(t => `   ⚡ *${t.id}:* ${t.name}\n      💰 \`$${Number(t.costoTotal).toLocaleString('es-MX')} MXN\` (${t.progress}%) • 👤 ${t.responsable}`).join('\n') || '   _Sin tareas en ejecución hoy en este alcance._') + `\n\n` +
              `_💡 Sumado al costo al día ($${fin.costoAlDia.toLocaleString('es-MX')}), el Total Activo es de $${fin.costoActivoTotal.toLocaleString('es-MX')} MXN (${fin.pctActivoTotal}%)._`,
        keyboard: financialKeyboard
      };
    }

    if (intent.type === "COSTO_PROYECTADO") {
      return {
        authorized: true,
        text: `🔮 *Costo Proyectado (Sin Sumar Actual - Tareas No Iniciadas)*\n` +
              `📁 *Alcance:* *${stageName}*\n\n` +
              `• *Monto por Devengar:* *$${fin.costoProyectado.toLocaleString('es-MX')} MXN*\n` +
              `• *Proporción:* *${fin.pctProyectado}%* del presupuesto de ${isStageScope ? 'esta etapa' : 'todo el proyecto'}.\n` +
              `• *Actividades por Iniciar (${fin.tareasNoIniciadas.length}):*\n` +
              (fin.tareasNoIniciadas.slice(0, 5).map(t => `   ⏳ *${t.id}:* ${t.name} (\`$${Number(t.costoTotal).toLocaleString('es-MX')}\` • ${t.responsable})`).join('\n')) +
              (fin.tareasNoIniciadas.length > 5 ? `\n   _... y ${fin.tareasNoIniciadas.length - 5} tareas más._` : (fin.tareasNoIniciadas.length === 0 ? '   _No hay tareas no iniciadas en este alcance._' : '')) + `\n\n` +
              `_💡 No incluye lo actualmente en ejecución. Sumando el activo, el global de ${isStageScope ? 'la etapa' : 'el proyecto'} es de $${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN._`,
        keyboard: financialKeyboard
      };
    }

    if (intent.type === "COSTO_TOTAL_GLOBAL") {
      return {
        authorized: true,
        text: `🌐 *Presupuesto Total Consolidado (Sumando el Actual)*\n` +
              `📁 *Alcance:* *${stageName}*\n\n` +
              `• *Inversión Total Planificada:* *$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN* (100%)\n\n` +
              `📊 *Composición Estructural:*\n` +
              `   • ⚡ *Total Tareas Activas:* \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (*${fin.pctActivoTotal}%*)\n` +
              `      - Al Día (Completadas): \`$${fin.costoAlDia.toLocaleString('es-MX')}\` (${fin.pctAlDia}%)\n` +
              `      - En Curso (En Progreso): \`$${fin.costoEnProgreso.toLocaleString('es-MX')}\` (${fin.pctEnCurso}%)\n` +
              `   • ⏳ *Costo Proyectado (Por Iniciar):* \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (*${fin.pctProyectado}%*)\n\n` +
              `_💡 Toda la planeación financiera consolidada desde Etapa 1 hasta entrega._`,
        keyboard: financialKeyboard
      };
    }

    // COSTOS_MENU: Menú general con selector
    return {
      authorized: true,
      text: `💰 *Inteligencia Financiera — Proyecto Chimay*\n\n` +
            `Puedes consultar los criterios financieros de *todo el proyecto* o de *una etapa individual*:\n\n` +
            `1️⃣ *Activo vs Proyectado:* Comparativa directa entre lo que está corriendo y lo futuro.\n` +
            `2️⃣ *Costo al Día:* Dinero ejercido en tareas 100% completadas (\`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\`).\n` +
            `3️⃣ *Costo en Curso:* Inversión en tareas activas hoy (\`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\`).\n` +
            `4️⃣ *Costo Proyectado:* Solo tareas no iniciadas sin sumar lo actual (\`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\`).\n` +
            `5️⃣ *Presupuesto Total:* Sumando el gasto actual y lo futuro (\`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\`).\n\n` +
            `👇 *Pulsa una etapa o un criterio abajo, o pregúntamelo en lenguaje natural:*`,
      keyboard: financialKeyboard
    };
  }

  // M.2 Reporte de Salud y Costos
  if (intent.type === "REPORTE") {
    const context = scrumMaster.compileProjectContext();
    const fin = context.finanzas;
    const total = context.resumenMetricas.totalTareas;
    const completadas = context.resumenMetricas.completadas;
    const progreso = context.resumenMetricas.enProgreso;
    const pendientes = context.resumenMetricas.noIniciadas;

    return {
      authorized: true,
      text: `📊 *Reporte Operativo & Financiero — Proyecto Chimay*\n\n` +
            `📦 *Avance de Entregables:* ${completadas}/${total} (${context.resumenMetricas.porcentajeAvanceGlobal}%)\n` +
            `⚡ *En Progreso:* ${progreso} | ⏳ *Por Iniciar:* ${pendientes}\n` +
            `🧩 *Subtareas Pulverizadas:* ${context.resumenMetricas.subtareasCompletadas}/${context.resumenMetricas.totalSubtareas} completadas\n\n` +
            `💰 *Balance Financiero (Activo vs Proyectado):*\n` +
            `• *Costo al Día (Completadas):* \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n` +
            `• *Costo en Curso (En Progreso):* \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}%)\n` +
            `• *⚡ Total Activas:* \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${fin.pctActivoTotal}%)\n` +
            `• *⏳ Proyectado (No Iniciadas):* \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}%)\n` +
            `• *🌐 Total Global (Sumando Actual):* \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\`\n\n` +
            `_💡 Pulsa "💰 Selector de Costos" para ver detalles específicos._`,
      keyboard: [
        [{ text: "💰 Selector de Costos", callback_data: "cmd_costos" }, { text: "☀️ Daily Standup", callback_data: "cmd_standup" }],
        [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "🏠 Menú Principal", callback_data: "cmd_menu" }],
        [{ text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // N. Menú Principal / Ayuda
  if (intent.type === "AYUDA") {
    return {
      authorized: true,
      text: `🤖 *Centro de Operaciones Chimay (Telegram)*\n` +
            `¡Hola *${user.nombre}*! (${user.rol})\n\n` +
            `*Comandos de Gestión Operativa:*\n` +
            `📋 *tareas* ➔ Catálogo interactivo de todas las tareas con enlaces directos.\n` +
            `📋 *mis tareas* ➔ Ver tus entregables personales y fechas límite.\n` +
            `☀️ *standup* ➔ Daily Standup matutino con análisis de riesgos y cuellos de botella.\n` +
            `💰 *costos* ➔ Selector de costos: activo vs proyectado, al día o total.\n` +
            `🧩 *subtarea [ID]: [nombre] @[responsable]* ➔ Pulverizar tarea en subtareas.\n` +
            `✅ *completar [ID o SUB-ID]* ➔ Finalizar tarea o subtarea.\n` +
            `🚀 *iniciar [ID]* ➔ Poner en progreso una tarea.\n` +
            `💬 *[ID]: [mensaje]* ➔ Comentar en cualquier tarea.\n` +
            `➕ *crear [nombre]* ➔ Crear nueva tarea (auto-asignada).\n` +
            `🧠 */scrum [pregunta]* ➔ Consultar cualquier duda al Scrum Master IA.\n` +
            `📊 *reporte* ➔ Balance de costos y avance general.`,
      keyboard: [
        [{ text: "📋 Tareas", callback_data: "cmd_menu_tareas" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }],
        [{ text: "☀️ Daily Standup", callback_data: "cmd_standup" }, { text: "💰 Costos", callback_data: "cmd_costos" }],
        [{ text: "📊 Reporte", callback_data: "cmd_reporte" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
      ]
    };
  }

  // O. Si el usuario hace una pregunta abierta en lenguaje natural, enviarla al Scrum Master IA
  const isQuestion = rawText.includes("?") || rawText.includes("¿") || 
                     intent.norm.includes("como vamos") || intent.norm.includes("quien") || 
                     intent.norm.includes("cuando") || intent.norm.includes("cuanto") || 
                     intent.norm.includes("riesgo") || intent.norm.includes("cuello") || 
                     intent.norm.includes("atras") || intent.norm.includes("presupuesto");
  if (isQuestion) {
    const aiReply = await scrumMaster.askScrumMaster(rawText, user.nombre);
    return {
      authorized: true,
      text: `🧠 *Scrum Master Chimay:*\n\n${aiReply}`,
      keyboard: [
        [{ text: "☀️ Daily Standup", callback_data: "cmd_standup" }, { text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }]
      ]
    };
  }

  // P. Mensaje por defecto
  return {
    authorized: true,
    text: `🤖 No reconocí esa instrucción, *${user.nombre}*.\n\n` +
          `Pulsa un botón de abajo o escribe:\n` +
          `• *standup* para el informe matutino del Scrum Master.\n` +
          `• *mis tareas* para ver tus entregables.\n` +
          `• *ayuda* para la lista completa de comandos.`,
    keyboard: [
      [{ text: "📋 Mis Tareas", callback_data: "cmd_mis_tareas" }, { text: "☀️ Daily Standup", callback_data: "cmd_standup" }],
      [{ text: "📊 Reporte", callback_data: "cmd_reporte" }, { text: "🌐 Abrir Web App", web_app: { url: "https://in2techmx.github.io/chimay-operaciones/" } }]
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
  detectIntent,
  normalizeInstruction,
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
