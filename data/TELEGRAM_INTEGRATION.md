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

---

## 2. Catálogo de Comandos de Telegram

| Comando | Formato de Ejemplo | ¿Quién puede ejecutarlo? | Acción en GitHub |
|---|---|---|---|
| **Menú / Ayuda** | `/start`, `ayuda`, `menu` | Cualquier usuario autorizado | Muestra instrucciones y botones interactivos. |
| **Mis Tareas** | `mis tareas`, `pendientes`, `/tareas` | Cualquier usuario autorizado | Lista entregables asignados con botones de acción rápida. |
| **Entrar a Hilo de Tarea** | `/tarea TSK-PRE-01` o deep-link web | Cualquier usuario autorizado | Activa conversación enfocada en la tarea sin prefijos. |
| **Salir de Hilo** | `/salir`, `menu` | Cualquier usuario autorizado | Regresa al menú principal del bot. |
| **Adjuntar Soporte** | Enviar PDF o Foto (con caption) | Cualquier usuario autorizado | Descarga archivo en `data/adjuntos/`, indexa en `adjuntos.json` y commitea. |
| **Completar Tarea** | `completar TSK-PRE-01` | **Solo el Responsable** | Modifica `estado: "Completada"`, avance 100% y genera commit en Git. |
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

### Opción A: Ejecución como Servicio Local / Daemon (Long Polling)
No requiere abrir puertos, ni configurar webhooks ni certificados SSL:

```powershell
# Definir el Token de Telegram provisto por @BotFather
$env:TELEGRAM_BOT_TOKEN="1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ"

# Iniciar el bot en la terminal
node scripts/telegram_bot.js
```

### Opción B: Consola y Simulador Integrado en la Web
En la página [chimay-operaciones](https://in2techmx.github.io/chimay-operaciones/):
1. Clic en el botón **Telegram** de la barra de navegación superior.
2. Abrir la pestaña **"Consola / Simulador Web"**.
3. Probar comandos (`mis tareas`, `completar TSK-PRE-01`, etc.) con respuesta interactiva y actualización del DOM en tiempo real.

### Opción C: Telegram Mini App (TWA)
* El portal web incluye el SDK oficial `telegram-web-app.js`.
* Al configurar el botón de menú en `@BotFather` apuntando a `https://in2techmx.github.io/chimay-operaciones/`, la aplicación corre en pantalla completa dentro de la app móvil de Telegram sin salir del chat.
