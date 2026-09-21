/**
 * scrum_master_ai.js - Agente IA Scrum Master y Motor de Inteligencia Ágil
 * Proyecto Chimay / Operaciones IN2TECHMX
 * Historias de Usuario: US-CHIMAY-SCRUM-01 & US-CHIMAY-SCRUM-02
 * 
 * Capacidades:
 * 1. Conocimiento total del proyecto: Tareas, Subtareas, Fechas, Presupuestos, Responsables y Bitácora.
 * 2. Generación del Daily Standup matutino con análisis de riesgos y cuellos de botella.
 * 3. Asistente conversacional para responder dudas sobre el proyecto en lenguaje natural.
 * 4. Integración ultra-económica con Google Gemini Flash (o fallback determinista ágil).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'proyectos.json');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const ATTACHMENTS_FILE = path.join(DATA_DIR, 'adjuntos.json');

// Utilidad de lectura JSON segura
function loadJson(filePath, defaultValue = null) {
  try {
    let target = filePath;
    if (!fs.existsSync(target)) {
      const rel = path.relative(REPO_ROOT, filePath);
      const cwdTarget = path.join(process.cwd(), rel);
      if (fs.existsSync(cwdTarget)) target = cwdTarget;
    }
    if (fs.existsSync(target)) {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    }
  } catch (e) {}
  return defaultValue;
}

// Obtener API Key de Gemini
function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
}

/**
 * Compila todo el estado del proyecto en una estructura analítica
 */
function compileProjectContext() {
  const projects = loadJson(PROJECTS_FILE, []);
  const users = loadJson(USERS_FILE, []);
  const attachments = loadJson(ATTACHMENTS_FILE, {});
  const hoy = new Date().toISOString().split('T')[0];

  const allTasks = [];
  const allSubtasks = [];
  let totalPresupuesto = 0;
  let totalHoras = 0;

  for (const proj of projects) {
    if (proj.etapas && Array.isArray(proj.etapas)) {
      for (const etapa of proj.etapas) {
        const tareasPath = path.join(DATA_DIR, etapa.path, 'tareas.json');
        const tasks = loadJson(tareasPath, []);
        tasks.forEach(t => {
          totalPresupuesto += (Number(t.costoTotal) || 0);
          totalHoras += (Number(t.horas) || 0);

          const taskObj = {
            id: t.id,
            wbs: t.wbs,
            etapa: t.etapa || etapa.name,
            name: t.name,
            responsable: t.responsable,
            estado: t.estado || "No Iniciada",
            progress: t.progress || 0,
            prioridad: t.prioridad || "Media",
            start: t.start,
            end: t.end,
            costoTotal: t.costoTotal || 0,
            horas: t.horas || 0,
            subtareas: t.subtareas || []
          };

          // Analizar subtareas
          if (t.subtareas && Array.isArray(t.subtareas)) {
            t.subtareas.forEach(sub => {
              allSubtasks.push({
                ...sub,
                parentTaskId: t.id,
                parentTaskName: t.name,
                etapa: taskObj.etapa
              });
            });
          }

          allTasks.push(taskObj);
        });
      }
    }
  }

  // Tareas por estado
  const completadas = allTasks.filter(t => t.estado === "Completada");
  const enProgreso = allTasks.filter(t => t.estado === "En Progreso");
  const noIniciadas = allTasks.filter(t => t.estado === "No Iniciada");

  // Cuellos de botella y riesgos
  // 1. Tareas vencidas no completadas
  const vencidas = allTasks.filter(t => t.estado !== "Completada" && t.end && t.end < hoy);
  // 2. Tareas críticas en riesgo
  const criticasEnRiesgo = allTasks.filter(t => t.prioridad === "Crítica" && t.estado !== "Completada");
  // 3. Tareas que inician pronto (próximos 7 días)
  const proximos7Dias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const inicianPronto = allTasks.filter(t => t.estado === "No Iniciada" && t.start && t.start >= hoy && t.start <= proximos7Dias);

  // Subtareas pendientes
  const subtareasPendientes = allSubtasks.filter(s => s.estado !== "Completada");

  // Carga por responsable
  const cargaRecursos = {};
  users.forEach(u => {
    cargaRecursos[u.nombre] = {
      tareasAsignadas: allTasks.filter(t => (t.responsable || "").includes(u.nombre)),
      subtareasAsignadas: allSubtasks.filter(s => (s.responsable || "").includes(u.nombre))
    };
  });

  return {
    fechaHoy: hoy,
    resumenMetricas: {
      totalTareas: allTasks.length,
      completadas: completadas.length,
      enProgreso: enProgreso.length,
      noIniciadas: noIniciadas.length,
      porcentajeAvanceGlobal: allTasks.length > 0 ? Math.round((completadas.length / allTasks.length) * 100) : 0,
      totalSubtareas: allSubtasks.length,
      subtareasCompletadas: allSubtasks.filter(s => s.estado === "Completada").length,
      subtareasPendientes: subtareasPendientes.length,
      totalPresupuesto,
      totalHoras
    },
    vencidas,
    criticasEnRiesgo,
    inicianPronto,
    enProgreso,
    subtareasPendientes,
    cargaRecursos,
    tareasDetalle: allTasks
  };
}

/**
 * Llamada HTTP nativa a la API de Google Gemini (2.0 Flash / 1.5 Flash)
 */
function callGeminiLlm(systemPrompt, userPrompt, apiKey) {
  return new Promise((resolve) => {
    const payload = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000
      }
    };

    const postData = JSON.stringify(payload);
    // Modelo gemini-1.5-flash o gemini-2.0-flash
    const pathUrl = `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: pathUrl,
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
          const json = JSON.parse(d);
          if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
            resolve(json.candidates[0].content.parts[0].text);
          } else if (json.error) {
            resolve(null);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

/**
 * Genera el Daily Standup matutino
 */
async function generateDailyStandup(options = {}) {
  const context = compileProjectContext();
  const apiKey = getGeminiApiKey();

  // Si hay Gemini API Key disponible, generamos una síntesis con IA
  if (apiKey) {
    const systemPrompt = `Eres el Scrum Master y Agile Coach experto de "Proyecto Chimay" (IN2TECHMX).
Tu misión es facilitar el Daily Standup matutino para el equipo operativo.
Debes ser pragmático, enfocado en bloqueos, cuellos de botella, riesgos y en impulsar la entrega de valor.
Usa formato Markdown compatible con Telegram (negritas con *, código con \`, listas con viñetas limpias).
Mantén el mensaje motivador, claro y de máximo 300 palabras.`;

    const userPrompt = `A continuación tienes el estado del proyecto en tiempo real (${context.fechaHoy}):
Métricas Generales:
- Avance Global: ${context.resumenMetricas.porcentajeAvanceGlobal}% (${context.resumenMetricas.completadas}/${context.resumenMetricas.totalTareas} tareas)
- Subtareas: ${context.resumenMetricas.subtareasCompletadas}/${context.resumenMetricas.totalSubtareas} completadas (${context.resumenMetricas.subtareasPendientes} pendientes)
- Presupuesto Comprometido: $${context.resumenMetricas.totalPresupuesto.toLocaleString('es-MX')} MXN

Tareas en Progreso:
${context.enProgreso.map(t => `- [${t.id}] ${t.name} (Resp: ${t.responsable}, Avance: ${t.progress}%)`).join('\n') || 'Ninguna en progreso hoy.'}

Subtareas Pendientes de Atención:
${context.subtareasPendientes.map(s => `- [${s.parentTaskId} > ${s.id}] ${s.name} (Resp: ${s.responsable}, Estado: ${s.estado})`).join('\n') || 'Sin subtareas pendientes.'}

Cuellos de Botella y Retrasos:
${context.vencidas.map(t => `- 🚨 RETRASADA [${t.id}] ${t.name} (Venció: ${t.end}, Resp: ${t.responsable})`).join('\n') || '✅ No hay tareas vencidas al día de hoy.'}

Tareas que Inician Pronto (Próximos 7 días):
${context.inicianPronto.map(t => `- ⏳ [${t.id}] ${t.name} (Inicia: ${t.start}, Resp: ${t.responsable})`).join('\n') || 'Sin inicios programados en los próximos 7 días.'}

Genera el Daily Standup estructurado en:
1. ☀️ Saludo y Estado del Sprint
2. ⚡ En Curso Hoy (quién hace qué)
3. 🚨 Cuellos de Botella y Riesgos Inmediatos
4. ⏳ Próximos Inicios y Preparación
5. 🎯 Foco del Día`;

    const aiResponse = await callGeminiLlm(systemPrompt, userPrompt, apiKey);
    if (aiResponse) {
      return aiResponse.trim();
    }
  }

  // Fallback Heurístico Ágil Determinista (100% confiable y sin costo si no hay API Key)
  return buildHeuristicDailyStandup(context);
}

/**
 * Plantilla de Daily Standup heurística estructurada (cero dependencias de IA)
 */
function buildHeuristicDailyStandup(ctx) {
  let text = `☀️ *Daily Standup — Proyecto Chimay*\n`;
  text += `📅 *Fecha:* \`${ctx.fechaHoy}\` | *Avance Global:* \`${ctx.resumenMetricas.porcentajeAvanceGlobal}%\`\n\n`;

  // 1. En progreso
  text += `⚡ *1. En Progreso Hoy:*\n`;
  if (ctx.enProgreso.length === 0) {
    text += `   _Sin tareas en curso activo. Selecciona una en /tareas para iniciarla._\n`;
  } else {
    ctx.enProgreso.forEach(t => {
      text += `   • *${t.id}:* ${t.name}\n     👤 \`${t.responsable}\` | 📊 ${t.progress}%\n`;
    });
  }
  text += `\n`;

  // 2. Subtareas pulverizadas pendientes
  if (ctx.subtareasPendientes.length > 0) {
    text += `🧩 *2. Subtareas Asignadas en Curso (${ctx.subtareasPendientes.length}):*\n`;
    ctx.subtareasPendientes.slice(0, 5).forEach(s => {
      text += `   • [${s.parentTaskId}] *${s.name}*\n     👤 Asignado: \`${s.responsable}\` (${s.estado})\n`;
    });
    text += `\n`;
  }

  // 3. Cuellos de botella y alertas
  text += `🚨 *3. Cuellos de Botella y Riesgos:*\n`;
  if (ctx.vencidas.length === 0) {
    text += `   ✅ *Excelente:* Todas las actividades están dentro del cronograma previsto.\n`;
  } else {
    ctx.vencidas.forEach(t => {
      text += `   ⚠️ *Demorada [${t.id}]:* ${t.name}\n      Venció el \`${t.end}\` (Responsable: *${t.responsable}*)\n`;
    });
  }
  text += `\n`;

  // 4. Próximos inicios
  text += `⏳ *4. Inicios en los Próximos 7 Días:*\n`;
  if (ctx.inicianPronto.length === 0) {
    text += `   _No hay nuevas tareas programadas para iniciar esta semana._\n`;
  } else {
    ctx.inicianPronto.forEach(t => {
      text += `   • *${t.id}:* ${t.name} (Arranca: \`${t.start}\` | Resp: \`${t.responsable}\`)\n`;
    });
  }
  text += `\n`;

  // 5. Foco del día
  text += `🎯 *5. Foco del Día Recomendado:*\n`;
  if (ctx.vencidas.length > 0) {
    text += `   👉 Resolver la tarea demorada *${ctx.vencidas[0].id}* con ${ctx.vencidas[0].responsable} para no impactar dependencias.\n`;
  } else if (ctx.enProgreso.length > 0) {
    text += `   👉 Dar seguimiento a *${ctx.enProgreso[0].id}* para alcanzar su meta de entrega.\n`;
  } else {
    text += `   👉 Arrancar las actividades preliminares de la siguiente etapa operativa.\n`;
  }

  return text.trim();
}

/**
 * Responde preguntas del equipo sobre el proyecto usando IA y contexto en vivo
 */
async function askScrumMaster(userQuestion, userName = "Equipo") {
  const context = compileProjectContext();
  const apiKey = getGeminiApiKey();

  if (apiKey) {
    const systemPrompt = `Eres el Scrum Master de Proyecto Chimay (IN2TECHMX).
Conoces todas las tareas, subtareas, costos, responsables, fechas y documentos.
Responde de forma concisa, precisa y ejecutiva en Markdown.
Si te preguntan por una tarea, persona o presupuesto, cita los datos reales del contexto provisto.`;

    const userPrompt = `Contexto del Proyecto:
${JSON.stringify({
  metricas: context.resumenMetricas,
  enProgreso: context.enProgreso,
  vencidas: context.vencidas,
  subtareas: context.subtareasPendientes,
  inicianPronto: context.inicianPronto,
  tareas: context.tareasDetalle.map(t => ({ id: t.id, name: t.name, resp: t.responsable, estado: t.estado, end: t.end, costo: t.costoTotal, subtareas: t.subtareas }))
}, null, 2)}

Pregunta de ${userName}: "${userQuestion}"`;

    const response = await callGeminiLlm(systemPrompt, userPrompt, apiKey);
    if (response) return response.trim();
  }

  // Respuesta heurística de respaldo si no hay API Key o falla
  const qLower = userQuestion.toLowerCase();
  if (qLower.includes("presupuesto") || qLower.includes("costo") || qLower.includes("dinero")) {
    return `💰 *Presupuesto Proyecto Chimay:*\nTotal comprometido: \`$${context.resumenMetricas.totalPresupuesto.toLocaleString('es-MX')} MXN\` a lo largo de ${context.resumenMetricas.totalTareas} tareas planificadas.`;
  }
  if (qLower.includes("riesgo") || qLower.includes("atras") || qLower.includes("cuello") || qLower.includes("demor")) {
    if (context.vencidas.length === 0) {
      return `✅ *Sin riesgos críticos detectados:* No tenemos tareas vencidas actualmente. El avance global es del ${context.resumenMetricas.porcentajeAvanceGlobal}%.`;
    }
    return `🚨 *Cuellos de Botella Detectados:*\nHay ${context.vencidas.length} tarea(s) con fecha vencida:\n` +
      context.vencidas.map(t => `• *${t.id}:* ${t.name} (Resp: ${t.responsable})`).join('\n');
  }
  if (qLower.includes("subtarea")) {
    return `🧩 *Estado de Subtareas:*\nTotal: ${context.resumenMetricas.totalSubtareas} | Completadas: ${context.resumenMetricas.subtareasCompletadas} | Pendientes: ${context.resumenMetricas.subtareasPendientes}.\nEscribe \`/tarea [ID]\` para ver o agregar subtareas a un entregable.`;
  }

  return `🤖 *Scrum Master Chimay:*\nHola ${userName}. Tengo mapeadas ${context.resumenMetricas.totalTareas} tareas (${context.resumenMetricas.porcentajeAvanceGlobal}% de avance) y ${context.resumenMetricas.totalSubtareas} subtareas.\n\nEscribe */standup* para ver el reporte matutino completo o consúltame sobre *presupuesto*, *riesgos* o *subtareas*.`;
}

module.exports = {
  compileProjectContext,
  generateDailyStandup,
  askScrumMaster,
  getGeminiApiKey
};
