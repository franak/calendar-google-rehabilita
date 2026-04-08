# Calendario público AVM146 Rehabilitación (servidor Node.js + cliente dinámico)

Aplicación web que muestra calendarios públicos de Google Calendar con configuración dinámica por dominio/URL y sistema de suscripciones con notificaciones por email.

**Características principales:**
- **Configuración dinámica**: La configuración del calendario se determina por dominio o parámetro URL (`?config=alias`)
- **Múltiples vistas**: Lista agrupada por día, Mes tipo calendario, Timeline y Gantt
- **Suscripciones**: Notificaciones por email cuando cambian eventos específicos o todos los eventos
- **Servidor Node.js**: Sincronización automática del ICS, caché local, endpoints API

---

## 1. Arquitectura

### Backend (Node.js)
- **server.js**: Servidor Express que sincroniza ICS de Google Calendar
- **database.js**: Base de datos SQLite para suscripciones
- **configs/*.json**: Archivos de configuración por tenant

### Frontend (HTML/CSS/JS)
- **index.html**: Estructura principal
- **app.js**: Lógica de vistas, carga dinámica de config, suscripciones
- **styles.css**: Diseño oscuro, moderno y responsive

### Configuración dinámica
- Endpoint `/apiserv/config` devuelve configuración basada en dominio o query param
- Archivos JSON en `configs/` para diferentes tenants
- Ejemplo: `http://localhost:8000?config=avm146` carga `configs/avm146.json`

---

## 2. Instalación y configuración

### 2.1. Dependencias

```bash
npm install
```

### 2.2. Configuración del servidor (.env)

Copia `.env.example` a `.env` y configura:

```env
PORT=8000
SYNC_INTERVAL_MINUTES=30
ICS_SOURCE_URL=https://calendar.google.com/calendar/ical/...%40group.calendar.google.com/public/basic.ics
LOG_LEVEL=info
NODE_ENV=production

# SMTP para notificaciones (opcional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu-email@gmail.com
SMTP_PASS=tu-app-password
SMTP_FROM=tu-email@gmail.com
SMTP_SECURE=false
```

### 2.3. Configuración de tenants

Crea el archivo `configs.json` con un array de configuraciones por tenant:

**configs.json:**
```json
[
  {
    "alias": "default",
    "calendarId": "default-calendar-id@group.calendar.google.com",
    "icsUrl": "/calendar.ics",
    "ganttGroupSeparators": [" - ", " — ", " | ", ":"],
    "madridHolidays": ["2026-01-01", "2026-12-25"],
    "googleApiKey": ""
  },
  {
    "alias": "avm146",
    "calendarId": "179a497285bff3a1e40cf1c18b60b7680ef3668c57ab50692387f957a1c9f7f6@group.calendar.google.com",
    "icsUrl": "/calendar.ics",
    "ganttGroupSeparators": [" - ", " — ", " | ", ":"],
    "madridHolidays": ["2026-05-15", "2026-04-02", "2026-04-03"],
    "googleApiKey": "TU_API_KEY_AQUI"
  }
]
```

Cada objeto debe tener un `alias` único que se usará para identificar la configuración.

### 2.4. Arrancar el servidor

```bash
npm start
```

Accede a `http://localhost:8000` o `http://localhost:8000?config=avm146`

---

## 3. Endpoints API

| Endpoint           | Método | Descripción                                     |
| ------------------ | ------ | ----------------------------------------------- |
| `/`                | GET    | Página principal                                |
| `/apiserv/config`      | GET    | Configuración dinámica (query: `?config=alias`) |
| `/apiserv/subscribe`   | POST   | Suscribirse a notificaciones                    |
| `/apiserv/unsubscribe` | DELETE | Cancelar suscripción                            |
| `/calendar.ics`    | GET    | ICS cacheado                                    |
| `/status`          | GET    | Estado del servidor                             |
| `/sync-now`        | GET    | Forzar sincronización                           |

---

## 4. Suscripciones y notificaciones

### Suscribirse desde la UI
1. En la vista Lista, haz clic en "Suscribirse a notificaciones" en cualquier evento
2. Ingresa tu email
3. Elige si quieres notificaciones para este evento específico o para todos

### Tipos de alertas
- **Específica**: Solo notificaciones para el evento seleccionado
- **General**: Notificaciones para cualquier cambio en el calendario

### Recepción de emails
- Emails se envían automáticamente cuando se detectan cambios en el ICS
- Requiere configuración SMTP en `.env`
- Formato HTML con detalles del evento y tipo de cambio

---

## 5. Desarrollo

### Estructura de archivos
```
calendar-google-rehabilita/
├── server.js              # Backend Express
├── app.js                 # Frontend dinámico
├── index.html             # HTML principal
├── styles.css             # Estilos
├── config.js              # Legacy (no usado)
├── configs.json           # Configuraciones de tenants
├── database.js            # SQLite para suscripciones
├── calendar-cache.ics     # Caché del ICS
├── .env                   # Config servidor
└── package.json
```

### Configuración legacy
La aplicación ya no usa `config.js` hard-coded. La configuración se carga dinámicamente desde `/apiserv/config`.

---

## 6. Deployment

Ver `INICIO_PRODUCCION.md` para instrucciones detalladas de deployment en servidor.

**URLs de ejemplo:**
- `https://tu-dominio.com` → usa config por dominio
- `https://tu-dominio.com?config=avm146` → fuerza config específica
- `https://avm146.tu-dominio.com` → config por subdominio

1. Ve a la consola de Google Cloud: `https://console.cloud.google.com/`.
2. Crea un proyecto nuevo (o usa uno existente).
3. En **APIs & Services → Library**, habilita **Google Calendar API**.
4. En **APIs & Services → Credentials**, crea una **API key**.
5. En la configuración de esa API key:
   - Restringe el uso a la **Google Calendar API**.
   - (Recomendado) Restringe también por dominios HTTP desde los que se usará la app.
6. Copia la API key y pégala en `window.GOOGLE_API_KEY` dentro de `config.js`.

### 2.3. Asegúrate de que el calendario es público

En la configuración del calendario en Google Calendar:

1. Ve a **Configuración y uso compartido** del calendario que quieras exponer.
2. Marca que se **comparta públicamente** (al menos “ver todos los detalles de eventos”).
3. Copia el **ID del calendario** (aparece como `algo@group.calendar.google.com`) y ponlo en `window.CALENDAR_ID` si no es el que ya viene por defecto.

---

## 3. Cómo ejecutar la app

Es una app estática; basta con servir los archivos con un servidor HTTP simple.

Ejemplos:

- Con Python 3:

  ```bash
  cd /ruta/a/la/carpeta
  python -m http.server 8000
  ```

- Con Node (si tienes `npx` y `serve`):

  ```bash
  cd /ruta/a/la/carpeta
  npx serve .
  ```

Luego abre en el navegador:

```text
http://localhost:8000
```

> **Nota:** abrir `index.html` directamente con `file://` puede fallar por políticas de CORS o de carga de scripts locales en algunos navegadores, por eso es mejor usar un servidor estático.

---

## 4. Uso de la interfaz

- **Selector de vista (arriba a la derecha)**:
  - **Lista**: muestra los eventos agrupados por día, con:
    - Fecha grande y legible.
    - Horario (“Todo el día” si aplica).
    - Título destacado.
    - Notas / observaciones (campo `description` del evento).
    - Ubicación (si la hay).
    - Enlace “Ver en Google Calendar”.
  - **Mes**: calendario mensual con:
    - Días en rejilla.
    - Contador de eventos por día.
    - Al hacer clic en un día con eventos, se abre un panel con los detalles de todos los eventos de ese día.
  - **Timeline**: línea de tiempo ordenada cronológicamente, con nodos por fecha y tarjetas para cada evento.

- **Buscador de texto**:
  - Filtra por texto en el **título**, **descripción** o **ubicación**.
  - Aplica el filtro a todas las vistas.

---

## 5. Detalles técnicos

- Rango de fechas: por defecto, desde hoy hasta dentro de **3 meses**.
- Parámetros de la API:
  - `singleEvents=true` y `orderBy=startTime` para obtener los eventos “expandido” (incluyendo recurrencias) y ordenados.
  - Se usa `timeMin` / `timeMax` para limitar el rango.
- Campos de evento usados:
  - `start.dateTime` / `start.date` (para detectar si es de día completo).
  - `end.dateTime` / `end.date`.
  - `summary` (título).
  - `description` (notas / observaciones).
  - `location`.
  - `htmlLink` (enlace al evento en Google Calendar).

---

## 6. Personalización

- Puedes cambiar el título y textos de cabecera en `index.html`.
- Puedes ajustar colores, tipografías y detalles de diseño en `styles.css`.
- Si quieres cambiar el rango de fechas por defecto, modifica `DEFAULT_MONTH_RANGE` en `app.js`.

