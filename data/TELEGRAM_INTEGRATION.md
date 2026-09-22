# Integración de Telegram con Git-as-a-Database
## Proyecto Chimay — Centro de Operaciones (`in2techmx/chimay-operaciones`)
### Historia de Usuario: US-CHIMAY-TEL-01

Este documento detalla la arquitectura, normas de seguridad y modo de operación del asistente de **Telegram** conectado directamente al repositorio de **GitHub** bajo el estándar **Git-as-a-Database** (`github-data-organization`).

---

## 1. Principios y Reglas de Negocio

1. **Control de Acceso Estricto (Gate 2 AS):**
   - El acceso al bot está restringido exclusivamente a los integrantes registrados en `data/usuarios.json`.
   - **Rechazo Anónimo (Zero Information Disclosure):** Si un usuario no registrado escribe al bot, recibe textualmente:
     > `🚫 Acceso no autorizado. Tu ID de Telegram es [XXXXX]. Solicita a Web Master brindarte acceso.`
     > *(No se divulgan nombres personales, roles, datos de proyectos ni detalles internos).*

2. **Regla de Propiedad Estricta para Modificaciones:**
   - **Solo el responsable asignado** a una tarea puede modificar su estado (`completar [ID]`, `iniciar [ID]`, reprogramar fechas).
   - Si otro integrante intenta modificarla, el bot deniega el cambio:
     > `⚠️ Permiso denegado: Solo el responsable asignado ([Responsable]) puede modificar esta tarea.`

3. **Chat Universal y Colaborativo:**
   - **Cualquier usuario autorizado puede chatear en cualquier tarea** enviando `[ID]: [mensaje]`.
   - **Modo Conversación Enfocada:** Mediante `/tarea [ID]` o el botón *Abrir en Telegram* de la web, se entra al hilo directo de la tarea para chatear fluidamente sin necesidad de prefijos.
   - La nota queda asentada en `data/proyectos/[PRJ]/comentarios.json` con fecha, hora, autor y canal "Telegram", visible de inmediato en la web.

4. **Creación Universal de Tareas con Auto-Asignación:**
   - **Cualquier usuario autorizado puede dar de alta tareas** enviando `crear [nombre de la tarea]`.
   - El sistema genera el código WBS consecutivo y **asigna automáticamente como responsable al usuario que la envió**.

5. **Soporte Documental (Facturas, Hojas de Recepción, Oficios Sellados):**
   - Se pueden cargar archivos (PDF, JPG, PNG) desde la web o enviándolos directamente al bot de Telegram dentro del hilo de la tarea.
   - Los documentos se indexan en `data/adjuntos.json` y se respaldan en `data/adjuntos/[taskId]/` bajo Git-as-a-Database.

6. **Protección Anti-Errores: Confirmación Requerida (SI / NO) para Completar:**
   - Para evitar marcar actividades como completadas accidentalmente desde dispositivos móviles, cualquier instrucción de completado (`completar [ID]`, `completar [SUB-ID]` o botones inline) solicita confirmación explícita mediante un diálogo interactivo:
     > `⚠️ Confirmación Requerida: ¿Confirmas que deseas marcar como COMPLETADA la tarea "XXXX" (TSK-XXX)?`
     > `[✅ Sí, completar] [❌ No, cancelar]`
   - Si se cancela, los datos permanecen intactos. Si se confirma, se actualiza el estado al 100% y se genera el commit en Git.

7. **Catálogo Interactivo de Tareas (Menú de Enlaces con Nombres Topados):**
   - El botón principal **[📋 Tareas]** despliega la lista completa de entregables del proyecto organizada como botones de enlace (1 tarea por fila).
   - Los títulos largos son truncados inteligentemente (a ~28 caracteres + `…`) con su identificador e indicador de porcentaje (ej: `⚡ TSK-PRE-01: Elaboración de Propuesta... (50%)`), garantizando legibilidad total en pantallas móviles.
   - Al pulsar cualquiera de estos botones, el bot entra directamente al hilo enfocado de la tarea con todas sus subtareas y acciones.

---

## 2. Catálogo de Comandos de Telegram

| Comando | Formato de Ejemplo | ¿Quién puede ejecutarlo? | Acción en GitHub |
|---|---|---|---|
| **Menú / Ayuda** | `/start`, `ayuda`, `menu` | Cualquier usuario autorizado | Muestra instrucciones y botones interactivos. |
| **Catálogo de Tareas** | `tareas`, `/tareas`, `catalogo`, `[📋 Tareas]` | Cualquier usuario autorizado | Despliega botones interactivos de 1 fila por tarea con enlaces directos. |
| **Mis Tareas** | `mis tareas`, `pendientes`, `[📋 Mis Tareas]` | Cualquier usuario autorizado | Lista entregables asignados al usuario con botones de acción rápida. |
| **Entrar a Hilo de Tarea** | `/tarea TSK-PRE-01` o clic en botón | Cualquier usuario autorizado | Activa conversación enfocada en la tarea y lista sus subtareas. |
| **Salir de Hilo** | `/salir`, `menu`, `[🔙 Salir del Hilo]` | Cualquier usuario autorizado | Regresa al menú principal del bot. |
| **Adjuntar Soporte** | Enviar PDF o Foto (con caption) | Cualquier usuario autorizado | Descarga archivo en `data/adjuntos/`, indexa en `adjuntos.json` y commitea. |
| **Completar Tarea** | `completar TSK-PRE-01` o botón | **Solo el Responsable** | Solicita confirmación SI / NO. Tras confirmación, avanza al 100% y commitea. |
| **Completar Subtarea** | `completar SUB-PRE-01-01` o botón | **Cualquier responsable** | Solicita confirmación SI / NO. Recalcula rollup de la tarea padre y commitea. |
| **Iniciar Tarea** | `iniciar TSK-PRE-01` | **Solo el Responsable** | Modifica `estado: "En Progreso"`, avance 50% y genera commit en Git. |
| **Comentar en Bitácora** | `TSK-PRE-01: Se aplicó abono` | **Cualquier integrante** | Agrega comentario a `comentarios.json` y genera commit en Git. |
| **Crear Nueva Tarea** | `crear Instalación de mangueras` | **Cualquier integrante** | Da de alta la tarea en `tareas.json` y **auto-asigna al creador**. |
| **Reporte Financiero** | `reporte`, `costos`, `balance` | Cualquier usuario autorizado | Informa avance global, porcentaje y presupuesto comprometido. |

---

## 3. Bot Oficial de Telegram (@ChimayOpsBot)

El bot oficial de la plataforma está registrado y vinculado como:
* **Nombre de Usuario:** `@ChimayOpsBot`
* **Enlace Directo:** [https://t.me/ChimayOpsBot](https://t.me/ChimayOpsBot)
* **Código QR:** Generado dinámicamente en el modal de la aplicación web.

### Alta o Reconfiguración con @BotFather (si aplica)
Si requieres reconfigurar el bot o regenerar el token:
1. **Abrir BotFather:** En Telegram, busca y abre [@BotFather](https://t.me/BotFather).
2. **Consultar Token:** Envía `/mybots` > Selecciona `@ChimayOpsBot` > **API Token**.
3. **Guardar el Token de API:** BotFather entrega el HTTP API Token (ej: `123456789:ABCdefGh...`). Úsalo para arrancar el servicio en segundo plano.

---

## 4. Modo de Ejecución del Bot

### Opción A: Despliegue 24/7 en la Nube (Vercel Serverless Webhook - Recomendado)
Esta opción permite que **@ChimayOpsBot** responda **día y noche los 365 días del año** sin depender de ninguna computadora local:

1. **Importar el Repositorio en Vercel (Gratis):**
   * Entra a [https://vercel.com](https://vercel.com) e inicia sesión con tu cuenta de GitHub (`in2techmx`).
   * Haz clic en **"Add New Project"** y selecciona el repositorio **`in2techmx/chimay-operaciones`**.
   * En la sección **Environment Variables**, agrega:
     * `TELEGRAM_BOT_TOKEN`: El token secreto entregado por `@BotFather`.
     * `GITHUB_TOKEN`: Tu Personal Access Token (PAT) de GitHub para registrar los commits automáticamente.
   * Haz clic en **"Deploy"**. En 20 segundos Vercel te dará tu URL pública (ejemplo: `https://chimay-operaciones.vercel.app`).

2. **Vincular el Webhook con Telegram (1 solo paso):**
   Abre una terminal o tu navegador y abre:
   ```bash
   https://api.telegram.org/bot<TU_BOT_TOKEN>/setWebhook?url=https://tu-proyecto.vercel.app/api/telegram
   ```
   *O ejecuta el script:*
   ```powershell
   node scripts/set_webhook.js https://tu-proyecto.vercel.app/api/telegram
   ```
   **¡Listo!** A partir de ese momento, Telegram enviará cada mensaje directamente a tu servidor en la nube y el bot responderá de inmediato 24/7.

---

### Opción B: Ejecución como Servicio Local (Long Polling)
Para pruebas o desarrollo local en tu computadora:
```powershell
# Iniciar el bot en la terminal (autocarga variables desde tu archivo .env)
node scripts/telegram_bot.js
```

---

### Opción C: Consola y Simulador Integrado en la Web
En la página [chimay-operaciones](https://in2techmx.github.io/chimay-operaciones/):
1. Clic en el botón **Telegram** de la barra de navegación superior.
2. Abrir la pestaña **"Consola / Simulador Web"**.
3. Probar comandos (`mis tareas`, `completar TSK-PRE-01`, etc.) con respuesta interactiva y actualización del DOM en tiempo real.

### Opción C: Telegram Mini App (TWA)
* El portal web incluye el SDK oficial `telegram-web-app.js`.
* Al configurar el botón de menú en `@BotFather` apuntando a `https://in2techmx.github.io/chimay-operaciones/`, la aplicación corre en pantalla completa dentro de la app móvil de Telegram sin salir del chat.
