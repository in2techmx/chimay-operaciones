# 📚 Git-as-a-Database: Estructura de Datos y Especificación de Esquemas JSON

Este directorio (`data/`) funciona como la base de datos distribuida y versionada en GitHub (**Git-as-a-Database**) para el Centro de Operaciones y Cronograma Maestro del Ecosistema IN2TECHMX.

---

## 🗂️ Arquitectura de Carpetas Jerárquica

```text
data/
├── README.md                               # Este documento explicativo de esquemas y estructura
├── proyectos.json                          # Registro maestro de proyectos del portafolio
├── usuarios.json                           # Catálogo de usuarios, roles y permisos RBAC
│
└── proyectos/                              # Subcarpeta contenedora de proyectos
    │
    ├── PRJ-01-chimay/                      # Proyecto Agroecológico Chimay
    │   ├── proyecto.json                   # Metadatos generales, fechas y presupuesto del proyecto
    │   ├── recursos.json                   # Directorio de especialistas asignados y tarifas horarias
    │   ├── comentarios.json                # Bitácora de comentarios y chat colaborativo estilo Jira
    │   └── etapas/                         # 📁 SUBCARPETAS FÍSICAS DE ETAPAS INDEPENDIENTES
    │       ├── ETAPA-01-legal-y-gobernanza/
    │       │   ├── etapa.json              # Metadatos de la Etapa 1 (código WBS, líder, presupuesto)
    │       │   └── tareas.json             # Tareas operativas de la Etapa 1
    │       ├── ETAPA-02-infraestructura-hidraulica/
    │       │   ├── etapa.json              # Metadatos de la Etapa 2
    │       │   └── tareas.json             # Tareas operativas de la Etapa 2
    │       ├── ETAPA-03-estructuras-malla-sombra/
    │       │   ├── etapa.json              # Metadatos de la Etapa 3
    │       │   └── tareas.json             # Tareas operativas de la Etapa 3
    │       ├── ETAPA-04-siembra-y-produccion/
    │       │   ├── etapa.json              # Metadatos de la Etapa 4
    │       │   └── tareas.json             # Tareas operativas de la Etapa 4
    │       └── ETAPA-05-comercializacion/
    │           ├── etapa.json              # Metadatos de la Etapa 5
    │           └── tareas.json             # Tareas operativas de la Etapa 5
    │
    ├── PRJ-02-solar/                       # Proyecto Parque Solar 15kW
    │   ├── proyecto.json
    │   ├── recursos.json
    │   └── etapas/
    │       ├── ETAPA-01-ingenieria-y-permisos/
    │       │   ├── etapa.json
    │       │   └── tareas.json
    │       └── ETAPA-02-suministro-e-instalacion/
    │           ├── etapa.json
    │           └── tareas.json
    │
    └── PRJ-03-fungicos/                    # Proyecto Fúngicos & Biofábrica
        ├── proyecto.json
        ├── recursos.json
        └── etapas/
            └── ETAPA-01-cepas-y-sustratos/
                ├── etapa.json
                └── tareas.json
```

---

## 📋 Diccionario de Datos y Esquemas JSON

### 1. `proyectos.json` (Registro Maestro de Portafolio)
Ubicación: `data/proyectos.json`  
Propósito: Listado maestro de proyectos administrados por la plataforma.

| Campo | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | String | Sí | Identificador único del proyecto (ej. `PRJ-01`). |
| `slug` | String | Sí | Slug normalizado para carpetas y URLs (ej. `PRJ-01-chimay`). |
| `nombre` | String | Sí | Nombre oficial del proyecto. |
| `descripcion` | String | Sí | Resumen ejecutivo del objetivo y alcance. |
| `path` | String | Sí | Ruta relativa a la carpeta del proyecto dentro de `data/`. |
| `estado` | String | Sí | Estado del proyecto: `Activo`, `En Planificación`, `Completado`. |
| `color` | String | No | Código de color para identificación en UI. |
| `etapas` | Array | Sí | Lista de etapas registradas con sus IDs, slugs y rutas relativas. |

---

### 2. `usuarios.json` (Control de Acceso Basado en Roles - RBAC)
Ubicación: `data/usuarios.json`  
Propósito: Definición de identidades, roles oficiales, alcance de edición y avatar para cada especialista.

| Campo | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | String | Sí | Identificador de usuario (ej. `USR-AAA`). |
| `nombre` | String | Sí | Nombre canónico inamovible (ej. `Arturo A.`). |
| `email` | String | Sí | Correo electrónico principal asociado a Google Workspace/Gmail. |
| `aliasEmail` | String | No | Correo secundario o alternativo. |
| `rol` | String | Sí | Cargo oficial dentro de la estructura operativa de IN2TECHMX. |
| `puedeEditar` | Boolean | Sí | `true` si el usuario tiene permiso para editar tareas. |
| `alcanceEdicion`| String | Sí | `todas` (edición global) o `asignadas` (solo tareas donde es responsable). |
| `avatarBg` | String | Sí | Clase CSS de Tailwind para color de avatar (ej. `bg-purple-600`). |
| `initials` | String | Sí | Iniciales para el avatar visual (ej. `AA`). |

---

### 3. `proyecto.json` (Metadatos de Proyecto Específico)
Ubicación: `data/proyectos/[PRJ-ID]/proyecto.json`  
Propósito: Metadatos globales de presupuesto, ubicación y directores del proyecto.

| Campo | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | String | Sí | ID del proyecto (coincide con `proyectos.json`). |
| `codigo` | String | Sí | Código de referencia formal (ej. `CHIMAY-2026`). |
| `nombre` | String | Sí | Nombre oficial del proyecto. |
| `ubicacion` | String | Sí | Ubicación geográfica o instalación física. |
| `fechaInicio` | String (YYYY-MM-DD) | Sí | Fecha formal de arranque. |
| `fechaFinEstimada` | String (YYYY-MM-DD) | Sí | Fecha estimada de culminación. |
| `presupuestoTotal` | Number | Sí | Presupuesto total consolidado en MXN. |
| `moneda` | String | Sí | Código de divisa ISO 4217 (ej. `MXN`). |
| `estado` | String | Sí | Estado de avance general. |
| `directorProyecto` | String | Sí | Especialista líder responsable del proyecto. |

---

### 4. `etapa.json` (Metadatos de Etapa Específica)
Ubicación: `data/proyectos/[PRJ-ID]/etapas/[ETAPA-ID]/etapa.json`  
Propósito: Metadatos y delimitación de una etapa de trabajo individual.

| Campo | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | String | Sí | Identificador de etapa (ej. `ETAPA-01`). |
| `slug` | String | Sí | Nombre de carpeta normalizado (ej. `ETAPA-01-legal-y-gobernanza`). |
| `wbsCode` | String | Sí | Código WBS base de la etapa (ej. `1.0`, `2.0`, `3.0`). |
| `nombre` | String | Sí | Título descriptivo de la etapa. |
| `responsableLider` | String | Sí | Especialista líder de la etapa. |
| `rolLider` | String | Sí | Rol oficial del líder de etapa. |
| `fechaInicio` | String (YYYY-MM-DD) | Sí | Fecha de inicio de la etapa. |
| `fechaFin` | String (YYYY-MM-DD) | Sí | Fecha de finalización programada. |
| `presupuestoObjetivo` | Number | Sí | Techo presupuestal asignado a la etapa. |
| `color` | String | Sí | Color de acento para la interfaz y Gantt. |
| `estado` | String | Sí | `No Iniciada`, `En Progreso`, `Completada`. |

---

### 5. `tareas.json` (Listado Operativo de Tareas de la Etapa)
Ubicación: `data/proyectos/[PRJ-ID]/etapas/[ETAPA-ID]/tareas.json`  
Propósito: Colección de tareas operativas y entregables que conforman la etapa.

| Campo | Tipo | Requerido | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | String | Sí | Código de tarea (ej. `TSK-PIL-01` o `TSK-01`). |
| `wbs` | String | Sí | Código WBS jerárquico (ej. `1.1`, `1.2`, `2.1`). |
| `etapaId` | String | Sí | ID de la etapa contenedora (`ETAPA-01`). |
| `etapa` | String | Sí | Nombre descriptivo de la etapa para visualización. |
| `name` | String | Sí | Nombre descriptivo de la tarea o entregable. |
| `responsable` | String | Sí | Especialista asignado (debe coincidir con `usuarios.json`). |
| `horas` | Number | Sí | Horas estimadas de trabajo. |
| `costoPersonal` | Number | Sí | Costo derivado de horas * tarifa horaria del especialista. |
| `costoMateriales` | Number | Sí | Presupuesto para compra de materiales e insumos directos. |
| `costoTerceros` | Number | Sí | Costo de trámites, licencias, contratistas o notaría. |
| `costoTotal` | Number | Sí | Suma de `costoPersonal + costoMateriales + costoTerceros`. |
| `start` | String (YYYY-MM-DD) | Sí | Fecha de inicio programada. |
| `end` | String (YYYY-MM-DD) | Sí | Fecha de finalización límite. |
| `progress` | Number (0-100) | Sí | Porcentaje de avance físico. |
| `estado` | String | Sí | `No Iniciada`, `En Progreso`, `Bloqueada`, `Completada`. |
| `prioridad` | String | Sí | `Baja`, `Media`, `Alta`, `Crítica`. |
| `dependencies` | String | No | ID de la tarea predecesora de la que depende. |

---

### 6. `recursos.json` (Directorio de Especialistas del Proyecto)
Ubicación: `data/proyectos/[PRJ-ID]/recursos.json`  
Propósito: Tarifas y disponibilidad de los especialistas asignados a este proyecto.

---

### 7. `comentarios.json` (Bitácora Colaborativa y Chat)
Ubicación: `data/proyectos/[PRJ-ID]/comentarios.json`  
Propósito: Registro cronológico de notas, evidencias y mensajes por cada tarea.

---

## 🎯 Protocolo para Nuevos Proyectos y Nuevas Etapas

1. **Creación de un Nuevo Proyecto**:
   - Crear la subcarpeta `data/proyectos/PRJ-[NN]-[slug]/`.
   - Inicializar `proyecto.json`, `recursos.json`, `comentarios.json` y la subcarpeta `etapas/`.
   - Registrar la entrada en `data/proyectos.json`.

2. **Creación de una Nueva Etapa**:
   - Crear la subcarpeta `data/proyectos/[PRJ-ID]/etapas/ETAPA-[NN]-[slug]/`.
   - Generar `etapa.json` con su código WBS base (`NN.0`).
   - Generar `tareas.json` con las tareas base (`NN.1`, `NN.2`).
   - Registrar la nueva etapa en el array `etapas` de `data/proyectos.json`.
