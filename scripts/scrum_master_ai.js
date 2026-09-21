/**
 * scrum_master_ai.js - Agente IA Scrum Master y Motor de Inteligencia Ágil
 * Proyecto Chimay / Operaciones IN2TECHMX
 * Historias de Usuario: US-CHIMAY-SCRUM-01 & US-CHIMAY-SCRUM-02
 * 
 * Capacidades:
 * 1. Conocimiento total del proyecto: Tareas, Subtareas, Fechas, Presupuestos, Responsables y Bitácora.
 * 2. Inteligencia Financiera:
 *    - Costo Real / Al Día (Tareas completadas)
 *    - Costo en Curso (Tareas en progreso)
 *    - Costo Activo Total (Completadas + En Progreso) vs Costo Proyectado (No Iniciadas - Sin sumar el actual)
 *    - Presupuesto Total Consolidado (Sumando el actual)
 * 3. Generación del Daily Standup matutino con análisis de riesgos y cuellos de botella.
 * 4. Asistente conversacional con selector de perspectivas de costo y respuestas contextuales.
 * 5. Integración ultra-económica con Google Gemini Flash (o fallback determinista ágil).
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
 * Calcula todas las dimensiones financieras de un conjunto de tareas:
 * - Costo al Día / Costo Real (tareas completadas)
 * - Costo en Curso (tareas en progreso)
 * - Costo Activo Total (completadas + en progreso)
 * - Costo Proyectado (no iniciadas - sin sumar el actual)
 * - Costo Total Global (sumando el actual)
 */
function calculateProjectFinances(tasks = []) {
  let costoCompletadas = 0; // Costo al Día / Costo Real ejercido
  let costoEnProgreso = 0;   // Costo en Curso (tareas activas en ejecución)
  let costoNoIniciadas = 0;  // Costo Proyectado (tareas no iniciadas - sin sumar actual)

  const tareasCompletadas = [];
  const tareasEnProgreso = [];
  const tareasNoIniciadas = [];

  tasks.forEach(t => {
    const c = Number(t.costoTotal) || 0;
    if (t.estado === "Completada") {
      costoCompletadas += c;
      tareasCompletadas.push(t);
    } else if (t.estado === "En Progreso") {
      costoEnProgreso += c;
      tareasEnProgreso.push(t);
    } else {
      costoNoIniciadas += c;
      tareasNoIniciadas.push(t);
    }
  });

  const costoActivoTotal = costoCompletadas + costoEnProgreso; // Activas = concluidas + en curso
  const costoTotalGlobal = costoActivoTotal + costoNoIniciadas; // Presupuesto total sumando el actual

  const pctAlDia = costoTotalGlobal > 0 ? Math.round((costoCompletadas / costoTotalGlobal) * 100) : 0;
  const pctEnCurso = costoTotalGlobal > 0 ? Math.round((costoEnProgreso / costoTotalGlobal) * 100) : 0;
  const pctActivoTotal = costoTotalGlobal > 0 ? Math.round((costoActivoTotal / costoTotalGlobal) * 100) : 0;
  const pctProyectado = costoTotalGlobal > 0 ? Math.round((costoNoIniciadas / costoTotalGlobal) * 100) : 0;

  return {
    costoAlDia: costoCompletadas,
    costoEnProgreso: costoEnProgreso,
    costoActivoTotal: costoActivoTotal,
    costoProyectado: costoNoIniciadas,
    costoTotalGlobal: costoTotalGlobal,
    pctAlDia,
    pctEnCurso,
    pctActivoTotal,
    pctProyectado,
    tareasCompletadas,
    tareasEnProgreso,
    tareasNoIniciadas
  };
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
  let totalHoras = 0;

  for (const proj of projects) {
    if (proj.etapas && Array.isArray(proj.etapas)) {
      for (const etapa of proj.etapas) {
        const tareasPath = path.join(DATA_DIR, etapa.path, 'tareas.json');
        const tasks = loadJson(tareasPath, []);
        tasks.forEach(t => {
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
            costoTotal: Number(t.costoTotal) || 0,
            costoPersonal: Number(t.costoPersonal) || 0,
            costoMateriales: Number(t.costoMateriales) || 0,
            costoTerceros: Number(t.costoTerceros) || 0,
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

  // Finanzas consolidadas
  const finanzas = calculateProjectFinances(allTasks);

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
      totalPresupuesto: finanzas.costoTotalGlobal,
      costoAlDia: finanzas.costoAlDia,
      costoEnProgreso: finanzas.costoEnProgreso,
      costoActivoTotal: finanzas.costoActivoTotal,
      costoProyectado: finanzas.costoProyectado,
      costoTotalGlobal: finanzas.costoTotalGlobal,
      pctAlDia: finanzas.pctAlDia,
      pctEnCurso: finanzas.pctEnCurso,
      pctActivoTotal: finanzas.pctActivoTotal,
      pctProyectado: finanzas.pctProyectado,
      totalHoras
    },
    finanzas,
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
        maxOutputTokens: 600
      }
    };

    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.candidates && json.candidates[0] && json.candidates[0].content) {
            const text = json.candidates[0].content.parts[0].text;
            resolve(text);
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
Incluye la perspectiva financiera: Activo vs Proyectado.
Mantén el mensaje motivador, claro y de máximo 320 palabras.`;

    const fin = context.finanzas;
    const userPrompt = `A continuación tienes el estado del proyecto en tiempo real (${context.fechaHoy}):
Métricas Operativas:
- Avance Global: ${context.resumenMetricas.porcentajeAvanceGlobal}% (${context.resumenMetricas.completadas}/${context.resumenMetricas.totalTareas} tareas)
- Subtareas: ${context.resumenMetricas.subtareasCompletadas}/${context.resumenMetricas.totalSubtareas} completadas (${context.resumenMetricas.subtareasPendientes} pendientes)

Balance Financiero (Activo vs Proyectado):
- Costo al Día (Completadas / Real): $${fin.costoAlDia.toLocaleString('es-MX')} MXN (${fin.pctAlDia}%)
- Costo en Curso (En Progreso): $${fin.costoEnProgreso.toLocaleString('es-MX')} MXN (${fin.pctEnCurso}%)
- Total Tareas Activas: $${fin.costoActivoTotal.toLocaleString('es-MX')} MXN (${fin.pctActivoTotal}%)
- Costo Proyectado (No Iniciadas / Sin sumar actual): $${fin.costoProyectado.toLocaleString('es-MX')} MXN (${fin.pctProyectado}%)
- Presupuesto Total Global (Sumando actual): $${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN (100%)

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
3. 💰 Balance Financiero (Activo vs Proyectado en 2 líneas concisas)
4. 🚨 Cuellos de Botella y Riesgos Inmediatos
5. ⏳ Próximos Inicios y Preparación
6. 🎯 Foco del Día`;

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
  const fin = ctx.finanzas;
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

  // 3. Balance Financiero: Tareas Activas vs Costo Proyectado
  text += `💰 *3. Balance Financiero (Activo vs Proyectado):*\n`;
  text += `   • *Costo al Día (Completadas):* \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n`;
  text += `   • *Costo en Curso (En Progreso):* \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}%)\n`;
  text += `   • *⚡ Total Tareas Activas:* \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${fin.pctActivoTotal}%)\n`;
  text += `   • *⏳ Proyectado (No Iniciadas):* \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}%)\n`;
  text += `   • *🌐 Total Global (Sumando Actual):* \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\`\n\n`;

  // 4. Cuellos de botella y alertas
  text += `🚨 *4. Cuellos de Botella y Riesgos:*\n`;
  if (ctx.vencidas.length === 0) {
    text += `   ✅ *Excelente:* Todas las actividades están dentro del cronograma previsto.\n`;
  } else {
    ctx.vencidas.forEach(t => {
      text += `   ⚠️ *Demorada [${t.id}]:* ${t.name}\n      Venció el \`${t.end}\` (Responsable: *${t.responsable}*)\n`;
    });
  }
  text += `\n`;

  // 5. Próximos inicios
  text += `⏳ *5. Inicios en los Próximos 7 Días:*\n`;
  if (ctx.inicianPronto.length === 0) {
    text += `   _No hay nuevas tareas programadas para iniciar esta semana._\n`;
  } else {
    ctx.inicianPronto.forEach(t => {
      text += `   • *${t.id}:* ${t.name} (Arranca: \`${t.start}\` | Resp: \`${t.responsable}\`)\n`;
    });
  }
  text += `\n`;

  // 6. Foco del día
  text += `🎯 *6. Foco del Día Recomendado:*\n`;
  if (ctx.vencidas.length > 0) {
    text += `   👉 Resolver la tarea demorada *${ctx.vencidas[0].id}* con ${ctx.vencidas[0].responsable} para no impactar dependencias.\n`;
  } else if (ctx.enProgreso.length > 0) {
    text += `   👉 Dar seguimiento a *${ctx.enProgreso[0].id}* para completar sus entregables.\n`;
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
  const fin = context.finanzas;
  const apiKey = getGeminiApiKey();

  if (apiKey) {
    const systemPrompt = `Eres el Scrum Master y Asesor Financiero Ágil de Proyecto Chimay (IN2TECHMX).
Conoces todas las tareas, subtareas, costos, responsables, fechas y documentos.
Tienes pleno dominio de las distintas perspectivas de costo:
1. Costo al Día / Real: Suma de tareas con estado Completada.
2. Costo en Curso: Suma de tareas con estado En Progreso.
3. Costo Activo Total: Tareas Completadas + En Progreso.
4. Costo Proyectado (sin sumar actual): Solo tareas con estado No Iniciada (remanente por devengar).
5. Costo Total Global (sumando actual): Tareas Activas + No Iniciadas (inversión total de inicio a fin).
Responde de forma concisa, precisa y ejecutiva en Markdown compatible con Telegram.`;

    const userPrompt = `Contexto del Proyecto:
${JSON.stringify({
  metricas: context.resumenMetricas,
  finanzas: {
    costoAlDia_Completadas: fin.costoAlDia,
    costoEnCurso_EnProgreso: fin.costoEnProgreso,
    costoActivoTotal: fin.costoActivoTotal,
    costoProyectado_NoIniciadas_SinActual: fin.costoProyectado,
    costoTotalGlobal_SumandoActual: fin.costoTotalGlobal,
    porcentajes: {
      pctAlDia: fin.pctAlDia,
      pctEnCurso: fin.pctEnCurso,
      pctActivoTotal: fin.pctActivoTotal,
      pctProyectado: fin.pctProyectado
    }
  },
  enProgreso: context.enProgreso.map(t => ({ id: t.id, name: t.name, resp: t.responsable, costo: t.costoTotal, progress: t.progress })),
  completadas: fin.tareasCompletadas.map(t => ({ id: t.id, name: t.name, resp: t.responsable, costo: t.costoTotal })),
  noIniciadas: fin.tareasNoIniciadas.map(t => ({ id: t.id, name: t.name, resp: t.responsable, costo: t.costoTotal }))
}, null, 2)}

Pregunta de ${userName}: "${userQuestion}"`;

    const response = await callGeminiLlm(systemPrompt, userPrompt, apiKey);
    if (response) return response.trim();
  }

  // Respuesta heurística determinista completa si no hay API Key o falla
  const qNorm = userQuestion.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // A. Costo al Día / Costo Real (Tareas Completadas)
  if (qNorm.includes("al dia") || qNorm.includes("costo real") || qNorm.includes("ejercido") || (qNorm.includes("completad") && qNorm.includes("cost"))) {
    return `💰 *Costo al Día / Real (Tareas Completadas):*\n\n` +
      `• *Monto Ejercido:* \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\`\n` +
      `• *Representa:* el *${fin.pctAlDia}%* del presupuesto global consolidado.\n` +
      `• *Entregables Concluidos al 100% (${fin.tareasCompletadas.length}):*\n` +
      (fin.tareasCompletadas.map(t => `   ✅ *${t.id}:* ${t.name} ($${Number(t.costoTotal).toLocaleString('es-MX')} MXN • ${t.responsable})`).join('\n') || '   _Sin tareas completadas aún._') + `\n\n` +
      `_💡 Si deseas ver también lo que se está ejecutando hoy, consulta por el "costo activo"._`;
  }

  // B. Costo Activo / En Curso / Activo vs Proyectado
  if (qNorm.includes("activo") || qNorm.includes("en curso") || qNorm.includes("en progreso") || qNorm.includes("activas")) {
    if (qNorm.includes("vs") || qNorm.includes("proyectado") || qNorm.includes("comparar") || qNorm.includes("diferencia")) {
      return `⚖️ *Balance Financiero: Tareas Activas vs Costo Proyectado*\n\n` +
        `⚡ *1. Tareas Activas (En Curso + Concluidas):*\n` +
        `   • Monto Total Activo: \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (*${fin.pctActivoTotal}%* del total)\n` +
        `   • Al Día (Completadas): \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n` +
        `   • En Curso (En Progreso): \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}%)\n\n` +
        `⏳ *2. Costo Proyectado (No Iniciadas - Sin Sumar Actual):*\n` +
        `   • Monto Proyectado Futuro: \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (*${fin.pctProyectado}%* del total)\n` +
        `   • Tareas por Iniciar: ${fin.tareasNoIniciadas.length} actividades planificadas.\n\n` +
        `🌐 *Presupuesto Total Consolidado (Sumando Actual):*\n` +
        `   • \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\` (100%)`;
    }

    return `⚡ *Costo de Tareas Activas (En Ejecución & Concluidas):*\n\n` +
      `• *En Curso Hoy:* \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}% en ${fin.tareasEnProgreso.length} tarea(s))\n` +
      `• *Al Día (Completadas):* \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}%)\n` +
      `• *Total Activo Comprometido:* \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (*${fin.pctActivoTotal}%* del presupuesto global).\n\n` +
      `_💡 El costo proyectado no iniciado es de $${fin.costoProyectado.toLocaleString('es-MX')} MXN (${fin.pctProyectado}%)._`;
  }

  // C. Costo Proyectado (No Iniciadas / Sin sumar o sumando actual)
  if (qNorm.includes("proyectado") || qNorm.includes("no iniciada") || qNorm.includes("futuro") || qNorm.includes("por iniciar")) {
    if (qNorm.includes("sumando") || qNorm.includes("con el actual") || qNorm.includes("total")) {
      return `🌐 *Costo Proyectado Total (Sumando el Actual):*\n\n` +
        `• *Presupuesto Global Consolidado:* \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\`\n` +
        `• *Composición:*\n` +
        `   - Activo Comprometido (Concluidas + En Curso): \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${fin.pctActivoTotal}%)\n` +
        `   - Por Iniciar en Futuras Etapas: \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}%)\n\n` +
        `_💡 Si buscas solo lo que falta por iniciar sin sumar lo actual, es de $${fin.costoProyectado.toLocaleString('es-MX')} MXN._`;
    }

    return `🔮 *Costo Proyectado (Sin Sumar Actual - Tareas No Iniciadas):*\n\n` +
      `• *Monto por Devengar:* \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\`\n` +
      `• *Representa:* el *${fin.pctProyectado}%* del presupuesto total (${fin.tareasNoIniciadas.length} tareas pendientes de arrancar).\n` +
      `• *Entregables Futuros:*\n` +
      fin.tareasNoIniciadas.slice(0, 4).map(t => `   ⏳ *${t.id}:* ${t.name} ($${Number(t.costoTotal).toLocaleString('es-MX')} MXN • ${t.responsable})`).join('\n') + `\n\n` +
      `_💡 Si deseas el total proyectado sumando el gasto actual, este asciende a $${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN._`;
  }

  // D. Balance General de Presupuesto / Costos
  if (qNorm.includes("presupuesto") || qNorm.includes("costo") || qNorm.includes("dinero") || qNorm.includes("inversion") || qNorm.includes("finanzas") || qNorm.includes("balance")) {
    return `💰 *Balance de Costos y Presupuesto — Proyecto Chimay*\n\n` +
      `El proyecto cuenta con distintas formas de visualizar los costos según el criterio de análisis:\n\n` +
      `1️⃣ *Costo al Día (Completadas / Real):*\n` +
      `   • \`$${fin.costoAlDia.toLocaleString('es-MX')} MXN\` (${fin.pctAlDia}% ejercido)\n\n` +
      `2️⃣ *Costo en Curso (En Progreso Hoy):*\n` +
      `   • \`$${fin.costoEnProgreso.toLocaleString('es-MX')} MXN\` (${fin.pctEnCurso}% en ejecución activa)\n\n` +
      `3️⃣ *Total Tareas Activas (Al Día + En Curso):*\n` +
      `   • \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${fin.pctActivoTotal}% comprometido)\n\n` +
      `4️⃣ *Costo Proyectado (Sin Sumar Actual - No Iniciadas):*\n` +
      `   • \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}% por devengar)\n\n` +
      `5️⃣ *Presupuesto Total Global (Sumando Actual):*\n` +
      `   • \`$${fin.costoTotalGlobal.toLocaleString('es-MX')} MXN\` (100% de la inversión planificada)\n\n` +
      `_💡 Puedes preguntarme cualquiera en específico (ej: "¿cuál es el costo al día?" o "activo vs proyectado")._`;
  }

  if (qNorm.includes("riesgo") || qNorm.includes("atras") || qNorm.includes("cuello") || qNorm.includes("demor")) {
    if (context.vencidas.length === 0) {
      return `✅ *Sin riesgos críticos detectados:* No tenemos tareas vencidas actualmente. El avance global es del ${context.resumenMetricas.porcentajeAvanceGlobal}%.`;
    }
    return `🚨 *Cuellos de Botella Detectados:*\nHay ${context.vencidas.length} tarea(s) con fecha vencida:\n` +
      context.vencidas.map(t => `• *${t.id}:* ${t.name} (Resp: ${t.responsable})`).join('\n');
  }

  if (qNorm.includes("subtarea")) {
    return `🧩 *Estado de Subtareas:*\nTotal: ${context.resumenMetricas.totalSubtareas} | Completadas: ${context.resumenMetricas.subtareasCompletadas} | Pendientes: ${context.resumenMetricas.subtareasPendientes}.\nEscribe \`/tarea [ID]\` para ver o agregar subtareas a un entregable.`;
  }

  return `🤖 *Scrum Master Chimay:*\nHola ${userName}. Tengo mapeadas ${context.resumenMetricas.totalTareas} tareas (${context.resumenMetricas.porcentajeAvanceGlobal}% de avance) y ${context.resumenMetricas.totalSubtareas} subtareas.\n\nPresupuesto Activo: \`$${fin.costoActivoTotal.toLocaleString('es-MX')} MXN\` (${fin.pctActivoTotal}%) vs Proyectado: \`$${fin.costoProyectado.toLocaleString('es-MX')} MXN\` (${fin.pctProyectado}%).\n\nEscribe */standup* para el reporte matutino o consúltame sobre *costo al día*, *costo proyectado* o *activo vs proyectado*.`;
}

module.exports = {
  compileProjectContext,
  calculateProjectFinances,
  generateDailyStandup,
  askScrumMaster,
  getGeminiApiKey
};
