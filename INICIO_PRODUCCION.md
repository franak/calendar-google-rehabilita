## Puesta en marcha en servidor (modo unificado con Node.js)

Este proyecto es una aplicación web servida por un servidor Node.js que:
- Sirve los archivos `index.html`, `styles.css`, `app.js` desde HTTP.
- Descarga periódicamente el archivo `.ics` de Google Calendar y lo cachea localmente.
- Expone el caché a través del endpoint `/calendar.ics` sin problemas de CORS.
- Proporciona configuración dinámica por dominio/URL desde archivos JSON.
- Gestiona suscripciones a eventos con notificaciones automáticas por email.

**Ventaja**: Un único proceso Node.js con configuración multi-tenant y sistema de notificaciones.

### 1. Preparar el código y la configuración

1. Copia todo el directorio `calendar-google-rehabilita` al servidor.
2. Instala las dependencias Node.js:
   ```bash
   cd /ruta/a/calendar-google-rehabilita
   npm install
   ```

3. Crea un archivo `.env` copiando `.env.example` y rellena los valores:
   ```bash
   cp .env.example .env
   ```
   Abre `.env` y asegúrate de:
   - Establecer `PORT=8000` (o el puerto que prefieras)
   - Rellenar `ICS_SOURCE_URL` con tu URL ICS completa de Google Calendar (la "Dirección secreta en formato iCal")
   - Opcionalmente ajustar `SYNC_INTERVAL_MINUTES` (por defecto 30 minutos)
   - **Nuevo**: Configurar SMTP para notificaciones (opcional):
     ```
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=587
     SMTP_USER=tu-email@gmail.com
     SMTP_PASS=tu-app-password
     SMTP_FROM=tu-email@gmail.com
     SMTP_SECURE=false
     ```

4. **Nuevo**: Crea el archivo `configs.json` con configuraciones por tenant:
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

### 2. Arrancar el servidor Node.js

En el servidor:

```bash
cd /ruta/a/calendar-google-rehabilita
npm start
```

Debería mostrarse algo como:

```text
[2026-03-20T10:55:03.022Z] Servidor corriendo en http://localhost:8000
[2026-03-20T10:55:03.022Z] Archivos estáticos servidos desde: /ruta/a/calendar-google-rehabilita
[2026-03-20T10:55:03.022Z] Endpoint ICS: http://localhost:8000/calendar.ics
[2026-03-20T10:55:03.022Z] Endpoint status: http://localhost:8000/status
[2026-03-20T10:55:03.500Z] Iniciando sincronización primera...
[2026-03-20T10:55:05.200Z] ✓ ICS sincronizado exitosamente. Tamaño: 5008 bytes
[2026-03-20T10:55:05.200Z] ✓ Sincronización periódica programada: cada 30 minutos
```

Mantén este proceso en marcha (puedes usar `tmux`, `screen`, `pm2` o configurarlo como servicio del sistema).

**Alternativa con PM2** (recomendado para producción):

```bash
# Instalar PM2 globalmente (una sola vez)
npm install -g pm2

# Iniciar el servidor con PM2
pm2 start server.js --name "calendar-server"

# Configurar para que se reinicie automáticamente
pm2 startup
pm2 save
```

### 3. Verificación rápida

1. Verifica que el endpoint de estado esté disponible:
   ```bash
   curl http://localhost:8000/status
   ```
   Debería devolver un JSON con el estado del servidor y última sincronización.

2. Verifica que el ICS se está sirviendo correctamente:
   ```bash
   curl http://localhost:8000/calendar.ics | head -10
   ```
   Debería mostrar contenido válido (BEGIN:VCALENDAR, etc).

3. Desde tu navegador, abre `http://<IP_DEL_SERVIDOR>:8000/index.html`.
   Deberías ver la interfaz del calendario con la barra de estado indicando que los eventos se cargan correctamente.

### 4. Configuración avanzada

#### 4.1. Configuración multi-tenant

Crea archivos JSON en el directorio `configs/` para diferentes configuraciones:

- `configs/default.json`: Configuración por defecto
- `configs/avm146.json`: Configuración específica para AVM146

Ejemplo de `configs/avm146.json`:
```json
{
  "calendarId": "179a497285bff3a1e40cf1c18b60b7680ef3668c57ab50692387f957a1c9f7f6@group.calendar.google.com",
  "icsUrl": "/calendar.ics",
  "ganttGroupSeparators": [" - ", " — ", " | ", ":"],
  "madridHolidays": ["2026-05-15", "2026-04-02", "2026-04-03"],
  "googleApiKey": "TU_API_KEY_DE_GOOGLE"
}
```

Acceso por URL:
- `http://tu-servidor.com` → usa config por dominio
- `http://tu-servidor.com?config=avm146` → fuerza config específica

#### 4.2. Configuración de notificaciones por email

Para habilitar notificaciones automáticas, configura SMTP en `.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu-email@gmail.com
SMTP_PASS=tu-app-password
SMTP_FROM=tu-email@gmail.com
SMTP_SECURE=false
```

Los usuarios pueden suscribirse desde la interfaz web para recibir emails cuando cambien eventos.

### 4. Endpoints disponibles

| Endpoint                               | Método | Descripción                                              |
| -------------------------------------- | ------ | -------------------------------------------------------- |
| `/`                                    | GET    | Sirve `index.html`                                       |
| `/calendar.ics`                        | GET    | Devuelve el ICS cacheado con headers CORS                |
| `/status`                              | GET    | Estado del servidor, última sincronización, tamaño caché |
| `/sync-now`                            | GET    | Fuerza sincronización manual del ICS desde Google        |
| `/styles.css`, `/app.js`, `/config.js` | GET    | Archivos estáticos                                       |

### 5. Variables de entorno (.env)

| Variable                | Ejemplo                                         | Descripción                               |
| ----------------------- | ----------------------------------------------- | ----------------------------------------- |
| `PORT`                  | `8000`                                          | Puerto donde escucha el servidor          |
| `ICS_SOURCE_URL`        | `https://calendar.google.com/calendar/ical/...` | URL ICS pública de Google Calendar        |
| `SYNC_INTERVAL_MINUTES` | `30`                                            | Cada cuántos minutos se sincroniza el ICS |
| `NODE_ENV`              | `production`                                    | Entorno (production/development)          |
| `LOG_LEVEL`             | `info`                                          | Nivel de logging                          |

### 6. Obtener la URL ICS de Google Calendar

1. Abre tu calendario en Google Calendar
2. Haz clic en **Configuración** → **Tu calendario** (el que quieras compartir)
3. Desplázate a **Integrar calendario**
4. Copia la **"Dirección secreta en formato iCal"** (URL que comienza con `https://calendar.google.com/calendar/ical/...`)
5. Pega esta URL en `.env` como `ICS_SOURCE_URL`

**Error: "incompatible architecture (have 'arm64', need 'x86_64')"**
- Causas: Has copiado la carpeta `node_modules` directamente desde un Mac (M1/M2/M3) a un servidor Intel, o viceversa. Las librerías nativas como `better-sqlite3` deben compilarse para la arquitectura específica del servidor.
- Solución: Borra los módulos e instala de nuevo en el servidor:
  ```bash
  rm -rf node_modules
  npm install
  ```
  O simplemente reconstruye los binarios:
  ```bash
  npm rebuild better-sqlite3
  ```

### 7. Solución de problemas

**Error: "Cannot find module 'express'"**
- Solución: Ejecuta `npm install` nuevamente

**Error: "PORT 8000 already in use"**
- Solución: Cambia el puerto en `.env` o detén el proceso que usa ese puerto

**No hay eventos en la interfaz**
- Verifica que `curl http://localhost:8000/calendar.ics` devuelve contenido
- Verifica que `ICS_SOURCE_URL` en `.env` es correcta
- Espera a que se complete la primera sincronización (puede tardar 5-10 segundos)
- Revisa la consola para errores de descarga

**Estados próximos: El servidor no se sincroniza**
- Verifica `http://localhost:8000/status` para ver cuándo fue la última sincronización
- Usa `http://localhost:8000/sync-now` para forzar sincronización manual
- Revisa que `SYNC_INTERVAL_MINUTES` en `.env` está configurado
