require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');

const SESSION_SECRET = process.env.ADMIN_PASS_HASH || crypto.randomBytes(32).toString('hex');

function sign(data) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
}

function createSessionCookie(user) {
    const data = Buffer.from(JSON.stringify({
        id: user.id,
        username: user.username,
        role: user.role,
        isSuperuser: user.isSuperuser || 0,
        email: user.email,
        envId: user.environmentId || user.envId,
        avatarUrl: user.avatarUrl || null
    })).toString('base64');
    const signature = sign(data);
    return `${data}.${signature}`;
}

function getCookie(req, name) {
    if (!req.headers.cookie) return null;
    const value = `; ${req.headers.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

function getSessionFromCookie(cookieVal) {
    if (!cookieVal) return null;
    const [data, signature] = cookieVal.split('.');
    if (!data || !signature) return null;
    if (sign(data) !== signature) return null;
    try {
        return JSON.parse(Buffer.from(data, 'base64').toString());
    } catch (e) {
        return null;
    }
}

// Middleware de autenticación de sesión para admin
function requireAdminAuth(req, res, next) {
    const session = getSessionFromCookie(getCookie(req, 'admin_session'));

    if (session) {
        req.user = session;
        return next();
    }

    if (req.path.startsWith('/apiserv/admin') || req.path.startsWith('/admin') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ error: 'Autenticación requerida' });
    }

    res.redirect('/?login=true');
}

// Middleware para roles específicos
function requireRole(roles) {
    return (req, res, next) => {
        requireAdminAuth(req, res, () => {
            if (req.user.isSuperuser || roles.includes(req.user.role)) {
                return next();
            }
            res.status(403).json({ error: 'Permisos insuficientes' });
        });
    };
}

function isAdmin(req) {
    return !!getSessionFromCookie(getCookie(req, 'admin_session'));
}
const ical = require('ical.js');

const app = express();

// Confiar en proxies para X-Forwarded-* headers
app.set('trust proxy', 1);

// ===== MIDDLEWARE CORS GLOBAL (PRIMERO) =====
app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    const requestMethod = req.method;
    
    // Headers CORS
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization,Cookie,X-HTTP-Method-Override');
    res.header('Access-Control-Max-Age', '86400');
    
    // Manejar OPTIONS preflight
    if (requestMethod === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ===== MIDDLEWARE JSON GLOBAL =====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const PORT = process.env.PORT || 8000;
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '30', 10);
const SYNC_INTERVAL_MS = SYNC_INTERVAL_MINUTES * 60 * 1000;
const EVENT_CACHE_HOURS = 24;
const ICS_SOURCE_URL = process.env.ICS_SOURCE_URL;
const CACHE_FILE = path.join(__dirname, 'calendar-cache.ics');

// Helper para obtener configuración desde la DB
async function getEnvConfig(alias) {
    const env = db.getEnvironmentByAlias(alias);
    if (!env) return null;
    return {
        ...env,
        ...env.configJson
    };
}

let lastSyncTime = null;
let syncInProgress = false;
let globalEventTitles = {}; // Map eventId -> eventTitle

// Logs
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Configurar transporte SMTP
const emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Helper para detectar entorno desde la petición
async function getEnvFromRequest(req) {
    // 1. Si hay sesión de admin, usar su envId
    const session = getSessionFromCookie(getCookie(req, 'admin_session'));
    if (session && session.envId) {
        return db.getEnvironmentById(session.envId);
    }

    // 2. Si hay parámetro ?config=alias o ?alias=alias
    let alias = req.query.config || req.query.alias || (req.body && (req.body.config || req.body.alias));
    
    // 3. Si no, por Host (subdominio)
    if (!alias) {
        const host = req.get('Host');
        if (host) alias = host.split('.')[0];
    }

    alias = alias || 'default';
    return db.getEnvironmentByAlias(alias);
}

// Función para construir URL de acceso usando la URL raíz actual del request
function getAccessUrl(req, env) {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:8000';
    const baseUrl = `${protocol}://${host}`;
    
    // Si hay un ?config en la URL actual, mantenerlo
    const originalConfig = req.query.config || req.query.alias;
    if (originalConfig) {
        return `${baseUrl}/?login=true&config=${originalConfig}`;
    }
    
    // Si no, usar el del entorno
    return `${baseUrl}/?login=true&config=${env.alias}`;
}

// Función para enviar notificación por email
async function sendNotificationEmail(email, subject, body) {
    try {
        await emailTransporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: subject,
            html: body
        });
        log(`Email enviado a ${email}: ${subject}`);
    } catch (error) {
        log(`ERROR enviando email a ${email}: ${error.message}`);
    }
}

// Función para enviar email de confirmación
async function sendConfirmationEmail(email, confirmationToken, returnUrl) {
    const confirmationUrl = `${process.env.BASE_URL || 'http://localhost:8000'}/confirm-email?token=${confirmationToken}${returnUrl ? '&redirect=' + encodeURIComponent(returnUrl) : ''}`;

    const subject = 'Confirma tu suscripción al calendario AVM146';
    const body = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2c3e50;">Confirma tu email</h2>
            <p>Hola,</p>
            <p>Gracias por suscribirte a las notificaciones del calendario de AVM146 Rehabilitación.</p>
            <p>Para activar tu suscripción y empezar a recibir notificaciones, confirma tu dirección de email haciendo clic en el botón siguiente:</p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${confirmationUrl}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                    Confirmar Email
                </a>
            </div>

            <p>Si el botón no funciona, copia y pega esta URL en tu navegador:</p>
            <p style="word-break: break-all; color: #666;">${confirmationUrl}</p>

            <p>Si no has solicitado esta suscripción, puedes ignorar este email.</p>

            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #666; font-size: 12px;">
                AVM146 Rehabilitación<br>
                Este email fue enviado automáticamente. Por favor, no respondas a este mensaje.
            </p>
        </div>
    `;

    await sendNotificationEmail(email, subject, body);
}

// Función para generar token de confirmación
function generateConfirmationToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Función para parsear eventos del ICS
function parseIcsEvents(icsContent) {
    const jcalData = ical.parse(icsContent);
    const comp = new ical.Component(jcalData);
    const events = comp.getAllSubcomponents('vevent');

    return events.map(event => {
        const uid = event.getFirstPropertyValue('uid');
        const summary = event.getFirstPropertyValue('summary');
        const start = event.getFirstPropertyValue('dtstart');
        const end = event.getFirstPropertyValue('dtend');
        const lastModified = event.getFirstPropertyValue('last-modified');

        return {
            uid,
            summary,
            start: start ? start.toJSDate() : null,
            end: end ? end.toJSDate() : null,
            lastModified: lastModified ? lastModified.toJSDate() : null
        };
    });
}

// Función para detectar cambios en eventos
function detectEventChanges(oldEvents, newEvents) {
    const changes = [];
    const oldEventMap = new Map(oldEvents.map(e => [e.uid, e]));
    const newEventMap = new Map(newEvents.map(e => [e.uid, e]));

    // Eventos nuevos
    for (const [uid, newEvent] of newEventMap) {
        if (!oldEventMap.has(uid)) {
            changes.push({ type: 'created', event: newEvent });
        }
    }

    // Eventos modificados o eliminados
    for (const [uid, oldEvent] of oldEventMap) {
        if (!newEventMap.has(uid)) {
            changes.push({ type: 'deleted', event: oldEvent });
        } else {
            const newEvent = newEventMap.get(uid);
            if (oldEvent.lastModified && newEvent.lastModified &&
                newEvent.lastModified > oldEvent.lastModified) {
                changes.push({ type: 'modified', event: newEvent, oldEvent });
            }
        }
    }

    return changes;
}

// Función para enviar notificaciones de cambios filtradas por entorno
async function sendChangeNotifications(changes, alias) {
    const env = db.getEnvironmentByAlias(alias);
    if (!env) {
        log(`ADVERTENCIA: No se pudo encontrar el entorno para alias ${alias} durante notificaciones.`);
        return;
    }

    for (const change of changes) {
        const { type, event } = change;
        const subscriptions = db.getSubscriptionsForEvent(event.uid, env.id);

        for (const sub of subscriptions) {
            const subject = `Cambio en evento del calendario [${env.title}]: ${event.summary}`;
            const body = `
                <h2>Notificación de cambio en calendario</h2>
                <p><strong>Entorno:</strong> ${env.title}</p>
                <p><strong>Evento:</strong> ${event.summary}</p>
                <p><strong>Tipo de cambio:</strong> ${type === 'created' ? 'Nuevo evento' : type === 'modified' ? 'Evento modificado' : 'Evento eliminado'}</p>
                <p><strong>Fecha de inicio:</strong> ${event.start ? event.start.toLocaleString() : 'N/A'}</p>
                <p><strong>Fecha de fin:</strong> ${event.end ? event.end.toLocaleString() : 'N/A'}</p>
                <p><strong>Última modificación:</strong> ${event.lastModified ? event.lastModified.toLocaleString() : 'N/A'}</p>
                <br>
                <p>Para gestionar tus suscripciones, visita: <a href="${process.env.BASE_URL || 'http://localhost:8000'}/?config=${env.alias}">Calendario ${env.title}</a></p>
            `;

            await sendNotificationEmail(sub.email, subject, body);
        }
    }
}

// Función para notificar a superusuarios sobre una nueva suscripción
async function notifySuperusersOfSubscription(env, user, alertType, eventTitle) {
    try {
        const superusers = db.getSuperusers();
        if (superusers.length === 0) return;

        log(`Notificando a ${superusers.length} superusuarios sobre nueva suscripción en ${env.alias}`);
        
        const typeLabel = alertType === 'dashboard' ? 'Dashboard' : (alertType === 'general' ? 'Todos los eventos' : 'Este Evento');
        const subject = `Nueva suscripción: ${env.title} [${typeLabel}]`;
        
        const bodyContent = `
            <h3>Nueva Suscripción Registrada</h3>
            <p><strong>Entorno:</strong> ${env.title} (${env.alias})</p>
            <p><strong>Usuario:</strong> ${user.name || 'Sin nombre'} (${user.email})</p>
            <p><strong>Tipo:</strong> ${typeLabel}</p>
            <p><strong>Evento/Doc:</strong> ${eventTitle || 'General'}</p>
            <hr>
            <small>Este es un aviso automático para superusuarios.</small>
        `;

        for (const admin of superusers) {
            await sendNotificationEmail(admin.email, subject, bodyContent);
        }
    } catch (err) {
        log(`ERROR notifySuperusersOfSubscription: ${err.message}`);
    }
}

// Función para enviar confirmación inmediata de suscripción al usuario
async function sendSubscriptionConfirmationToUser(env, user, alertType, eventTitle) {
    try {
        const typeLabel = alertType === 'dashboard' ? 'Dashboard' : (alertType === 'general' ? 'Todos los eventos' : 'Este Evento');
        const subject = `Suscripción confirmada: ${env.title}`;
        
        const bodyContent = `
            <h3>¡Suscripción Activada!</h3>
            <p>Hola ${user.name || ''},</p>
            <p>Te has suscrito correctamente a las notificaciones de <strong>${env.title}</strong>.</p>
            <ul>
                <li><strong>Tipo de alerta:</strong> ${typeLabel}</li>
                <li><strong>Referencia:</strong> ${eventTitle || 'General'}</li>
            </ul>
            <p>Recibirás un aviso por correo electrónico cuando haya cambios relevantes.</p>
            <hr>
            <small>AVM146 Rehabilitación</small>
        `;

        await sendNotificationEmail(user.email, subject, bodyContent);
    } catch (err) {
        log(`ERROR sendSubscriptionConfirmationToUser: ${err.message}`);
    }
}

// Función para enviar notificaciones de cambios en Dashboard (Infografías)
async function sendDashboardChangeNotifications(env, docLabel) {
    try {
        const subscriptions = db.getSubscriptionsForDashboard(env.id);
        if (subscriptions.length === 0) return;

        log(`Enviando ${subscriptions.length} notificaciones de Dashboard para ${env.alias}`);
        
        const subject = `Actualización en Dashboard [${env.title}]: ${docLabel}`;
        const dashboardUrl = `${process.env.BASE_URL || 'http://localhost:8000'}/?config=${env.alias}`;
        
        const bodyContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #3498db; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Actualización de Proyecto</h2>
                    <p style="margin: 5px 0 0 opacity: 0.9;">${env.title}</p>
                </div>
                <div style="padding: 20px; color: #333; line-height: 1.6;">
                    <p>Hola,</p>
                    <p>Te informamos que se han realizado cambios en la documentación principal (Dashboard) del proyecto <strong>${env.title}</strong>.</p>
                    <p>Documento actualizado: <strong>${docLabel}</strong></p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${dashboardUrl}" style="background-color: #2ecc71; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                            Ver Actualizaciones en el Dashboard
                        </a>
                    </div>
                    
                    <p style="font-size: 0.9em; color: #666;">
                        Este es un aviso automático porque estás suscrito a las actualizaciones de este proyecto.
                    </p>
                </div>
                <div style="background-color: #f9f9f9; padding: 15px; text-align: center; font-size: 11px; color: #999;">
                    AVM146 Rehabilitación - Gestión de Proyectos
                </div>
            </div>
        `;

        for (const sub of subscriptions) {
            await sendNotificationEmail(sub.email, subject, bodyContent);
        }
    } catch (err) {
        log(`ERROR en sendDashboardChangeNotifications: ${err.message}`);
    }
}

// Función auxiliar para parsear fechas del Sheet (ej: 17/03/26) a ISO / ICS Date (ej: 20260317)
function formatIcsDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.split('/');
    if (parts.length === 3) {
        const d = parts[0].padStart(2, '0');
        const m = parts[1].padStart(2, '0');
        const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        return `${y}${m}${d}`;
    }
    return null;
}

// Extraer solo VEVENTs de un ICS
function extractVevents(icsContent) {
    const startIdx = icsContent.indexOf('BEGIN:VEVENT');
    const endIdx = icsContent.lastIndexOf('END:VEVENT');
    if (startIdx === -1 || endIdx === -1) return '';
    return icsContent.substring(startIdx, endIdx + 10) + '\r\n';
}

// Función para descargar Sheet, convertir a ICS VEVENTs
async function fetchSheetEventsAsIcs(sheetUrl, sourceId) {
    if (!sheetUrl) return '';
    try {
        const response = await axios.get(sheetUrl, { timeout: 15000 });
        const records = parse(response.data, { skip_empty_lines: true });

        const nowUtc = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        let vevents = '';

        for (const row of records) {
            const id = row[0] ? String(row[0]).trim() : '';
            const title = row[1] ? String(row[1]).trim().replace(/\r?\n/g, ' ') : '';

            if (id && /^[\d.]+$/.test(id) && title) {
                const startStr = row[14];
                const endStr = row[15];

                const startIcs = formatIcsDate(startStr);
                const endIcs = formatIcsDate(endStr);

                if (startIcs) {
                    const dtIcsEnd = endIcs || startIcs;
                    const description = ((row[2] || '') + (row[3] ? ' - ' + row[3] : '')).replace(/\r?\n/g, '\\n');

                    vevents += 'BEGIN:VEVENT\r\n';
                    vevents += 'X-SOURCE-ID:' + sourceId + '\r\n';
                    vevents += 'UID:sheet-event-' + id.replace(/\./g, '-') + '\r\n';
                    vevents += 'DTSTAMP:' + nowUtc + '\r\n';
                    vevents += 'SUMMARY:' + title + '\r\n';
                    if (description) vevents += 'DESCRIPTION:' + description + '\r\n';
                    vevents += 'DTSTART;VALUE=DATE:' + startIcs + '\r\n';
                    vevents += 'DTEND;VALUE=DATE:' + dtIcsEnd + '\r\n';
                    vevents += 'END:VEVENT\r\n';
                }
            }
        }
        return vevents;
    } catch (error) {
        log(`Error obteniendo CSV del Sheet para fuente ${sourceId}: ${error.message}`);
        return '';
    }
}

// Función para adivinar categoría basada en palabras clave
function guessCategory(label, currentCat) {
    let l = label.toLowerCase();
    // Decodificar entidades comunes para el matching
    l = l.replace(/&aacute;/g, 'a').replace(/&eacute;/g, 'e').replace(/&iacute;/g, 'i').replace(/&oacute;/g, 'o').replace(/&uacute;/g, 'u');
    
    if (l.includes('gant') || l.includes('planific') || l.includes('calendario') || l.includes('cronograma') || l.includes('bloc de notas')) return "Planificación";
    if (l.includes('foto') || l.includes('imagen') || l.includes('antes') || l.includes('seguimiento') || l.includes('obra')) return "Seguimiento Visual";
    if (l.includes('catastro') || l.includes('maps') || l.includes('ubicación') || l.includes('localizaci') || l.includes('cts')) return "Legal/Ubicación";
    if (l.includes('cálculo') || l.includes('pago') || l.includes('presupuesto') || l.includes('económ') || l.includes('libro')) return "Administración Económica";
    if (l.includes('técnica') || l.includes('pvc') || l.includes('catálogo') || l.includes('catalog') || l.includes('manual') || l.includes('doc')) return "Documentación Técnica";
    
    // Si no hay match y la categoría actual es genérica, devolver Otros
    if (!currentCat || currentCat === "Enlaces Principales" || currentCat === "Otros" || currentCat === "General") {
        return "Otros";
    }
    return currentCat;
}

// Función para adivinar descripción basada en categoría
function guessDescription(label, category) {
    if (category === "Planificación") return "Cronograma y planificación detallada del proyecto.";
    if (category === "Seguimiento Visual") return "Seguimiento fotográfico de los trabajos y estado de obra.";
    if (category === "Legal/Ubicación") return "Documentación legal, ubicación y ficha catastral.";
    if (category === "Administración Económica") return "Control de presupuestos, pagos y gestión económica.";
    if (category === "Documentación Técnica") return "Manuales, catálogos de materiales y documentación técnica.";
    return "Documentación adicional del proyecto.";
}

// Función para sincronizar contenido de Google Docs para infografías de un alias específico
async function syncInfographicDoc(alias, doc) {
    const url = doc.url;
    if (!url) return;
    const docId = doc.id;
    log(`Sincronizando Google Doc para infografía [${doc.label}] de alias: ${alias}`);
    try {
        // Cambiar a export format HTML para extraer links
        let htmlUrl = url;
        if (htmlUrl.includes('/edit')) {
            htmlUrl = htmlUrl.replace('/edit', '/export?format=html');
        } else if (htmlUrl.includes('format=txt')) {
            htmlUrl = htmlUrl.replace('format=txt', 'format=html');
        } else if (!htmlUrl.includes('format=html')) {
            htmlUrl += (htmlUrl.includes('?') ? '&' : '?') + 'format=html';
        }

        const res = await axios.get(htmlUrl, { timeout: 15000 });
        const html = res.data;
        
        // 1. Extraer texto limpio para el resumen
        const docText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                            .replace(/<[^>]+>/g, '\n')
                            .replace(/\n\s*\n/g, '\n')
                            .trim();

        // 2. Extraer categorías y links (H1-H6 como categorías)
        const dynamicLinks = [];
        
        // Función para limpiar URLs de Google Redirect
        const cleanUrl = (url) => {
            try {
                const u = new URL(url);
                if (u.hostname === 'www.google.com' && u.pathname === '/url') {
                    return u.searchParams.get('q') || url;
                }
            } catch (e) {}
            return url.replace(/&amp;/g, '&');
        };

        const headerSplit = html.split(/<(h[1-6])[^>]*>/i);
        // El primer elemento es el contenido antes del primer H
        let firstPart = headerSplit[0];
        const firstLinks = [...firstPart.matchAll(/<a[^>]+href=["'](https?:\/\/.*?)["'][^>]*>(.*?)<\/a>/gi)];
        firstLinks.forEach(m => {
            const label = m[2].replace(/<[^>]+>/g, '').trim();
            if (label && label.length > 1) {
                const cat = guessCategory(label, "Enlaces Principales");
                dynamicLinks.push({
                    category: cat,
                    url: cleanUrl(m[1]),
                    label: label,
                    desc: guessDescription(label, cat)
                });
            }
        });

        for (let i = 1; i < headerSplit.length; i += 2) {
            const hTag = headerSplit[i];
            const content = headerSplit[i+1];
            
            const hTextMatch = content.match(/^(.*?)<\/h[1-6]>/i);
            const categoryName = hTextMatch ? hTextMatch[1].replace(/<[^>]+>/g, '').trim() : "Otros";
            
            const linkRegex = /<a[^>]+href=["'](https?:\/\/.*?)["'][^>]*>(.*?)<\/a>/gi;
            const linksInContent = [...content.matchAll(linkRegex)];
            
            linksInContent.forEach(m => {
                const label = m[2].replace(/<[^>]+>/g, '').trim();
                if (label && label.length > 1) {
                    // Evitar duplicados si ya están en Enlaces Principales
                    const url = cleanUrl(m[1]);
                    if (!dynamicLinks.some(l => l.url === url)) {
                        const cat = guessCategory(label, categoryName);
                        dynamicLinks.push({
                            category: cat,
                            url: url,
                            label: label,
                            desc: guessDescription(label, cat)
                        });
                    }
                }
            });
        }

        const currentHash = crypto.createHash('sha256').update(docText + JSON.stringify(dynamicLinks)).digest('hex');

        const cacheData = {
            docContent: docText,
            dynamicLinks: dynamicLinks,
            lastSync: new Date().toISOString(),
            contentHash: currentHash
        };

        const cachePath = path.join(__dirname, `infographic-cache-${alias}.json`);
        fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf8');

        // PERSISTIR EN BASE DE DATOS (Metadata)
        if (docId) {
            let existingMetadata = {};
            try {
                existingMetadata = doc.metadata ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata) : {};
            } catch (e) { existingMetadata = {}; }

            const oldHash = existingMetadata.contentHash;
            existingMetadata.infographicLinks = dynamicLinks;
            existingMetadata.lastExtracted = new Date().toISOString();
            existingMetadata.contentHash = currentHash;
            
            db.updateDocumentMetadata(docId, existingMetadata);
            log(`✓ Metadata de links actualizada para doc ${docId} [${doc.label}]`);

            // Notificar si hay cambios reales en contenido/links
            if (oldHash && oldHash !== currentHash) {
                log(`🔔 Cambio detectado en Dashboard [${doc.label}] para alias: ${alias}. Notificando...`);
                // Obtenemos el entorno completo para el título
                const env = db.getEnvironmentByAlias(alias);
                if (env) {
                    await sendDashboardChangeNotifications(env, doc.label);
                }
            }
        }
        log(`✓ Contenido y ${dynamicLinks.length} links dinámicos cacheados para ${alias} (Hash: ${currentHash.substring(0,8)})`);
    } catch (err) {
        log(`ERROR sincronizando Google Doc para ${alias}: ${err.message}`);
    }
}

// Función para iterar alias y sincronizar todas las fuentes desde la base de datos
async function syncAllAliases() {
    if (syncInProgress) {
        log('Sync ya en progreso, saltando...');
        return;
    }
    syncInProgress = true;
    log('Iniciando sincronización de todos los entornos...');

    try {
        const envs = db.getAllEnvironments();
        for (const env of envs) {
            const docs = db.getDocumentsByEnvironment(env.id);
            
            // 1. Sincronizar Infografías (Google Docs)
            const infographicDocs = docs.filter(d => d.type === 'infographic');
            if (infographicDocs.length === 0 && env.googleDocSource) {
                infographicDocs.push({ url: env.googleDocSource, label: 'Legacy' });
            }
            for (const doc of infographicDocs) {
                await syncInfographicDoc(env.alias, doc);
            }
            
            // 2. Sincronizar Fuentes de Eventos (ICS, Sheets)
            let eventSources = docs.filter(d => d.type === 'ics' || d.type === 'sheet');
            // Fallback a configJson.sources para transición suave
            if (eventSources.length === 0 && env.configJson && env.configJson.sources) {
                eventSources = env.configJson.sources;
            }

            if (eventSources.length > 0) {
                log(`Sincronizando ${eventSources.length} fuentes para alias: ${env.alias}`);
                await syncAliasSources(env.alias, eventSources);
            }
        }
        lastSyncTime = new Date();
    } catch (err) {
        log(`ERROR en syncAllAliases: ${err.message}`);
    } finally {
        syncInProgress = false;
    }
}

// Nueva función modular para sincronizar las fuentes de un alias
async function syncAliasSources(alias, sources) {
    const aliasCacheFile = path.join(__dirname, `calendar-cache-${alias}.ics`);
    let baseWrapper = null;
    let allVevents = '';

    for (const source of sources) {
        if ((source.type === 'ics' || source.type === 'sheet') && source.url) {
            const sourceId = source.id || (source.metadata ? (typeof source.metadata === 'string' ? JSON.parse(source.metadata).originalId : source.metadata.originalId) : 'legacy');
            
            if (source.type === 'ics') {
                try {
                    const res = await axios.get(source.url, { timeout: 15000, headers: { 'User-Agent': 'calendar-google-rehabilita/2.0' } });
                    let content = res.data;
    
                    // Inyectar etiqueta sourceId
                    content = content.replace(/BEGIN:VEVENT\r?\n/g, `BEGIN:VEVENT\r\nX-SOURCE-ID:${sourceId}\r\n`);
    
                    if (!baseWrapper) {
                        const firstVevent = content.indexOf('BEGIN:VEVENT');
                        if (firstVevent !== -1) {
                            baseWrapper = {
                                head: content.substring(0, firstVevent),
                                tail: '\r\nEND:VCALENDAR\r\n'
                            };
                        }
                    }
                    allVevents += extractVevents(content);
                } catch (e) {
                    log(`✗ Error ICS de fuente ${sourceId}: ${e.message}`);
                }
            } else if (source.type === 'sheet') {
                const sheetEvents = await fetchSheetEventsAsIcs(source.url, sourceId);
                allVevents += sheetEvents;
            }
        }
    }

    if (!baseWrapper) {
        baseWrapper = {
            head: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calendar Google Rehabilita//ES\r\nCALSCALE:GREGORIAN\r\n",
            tail: "END:VCALENDAR\r\n"
        };
    }
    const newIcsContent = baseWrapper.head + allVevents + baseWrapper.tail;

    // Detectar cambios contra el viejo para notificaciones
    let oldEvents = [];
    if (fs.existsSync(aliasCacheFile)) {
        try {
            const oldIcsContent = fs.readFileSync(aliasCacheFile, 'utf-8');
            oldEvents = parseIcsEvents(oldIcsContent);
        } catch (e) { }
    }

    const newEvents = parseIcsEvents(newIcsContent);
    newEvents.forEach(ev => {
        if (ev.id) globalEventTitles[ev.id] = ev.title || ev.summary || 'Sin título';
    });

    const changes = detectEventChanges(oldEvents, newEvents);
    if (changes.length > 0) {
        await sendChangeNotifications(changes, alias);
    }

    fs.writeFileSync(aliasCacheFile, newIcsContent, 'utf-8');
    log(`✓ Entorno ${alias} listo! Eventos: ${newEvents.length}. Cambios: ${changes.length}`);
}



// Endpoint para forzar sincronización manual
app.get('/sync-now', async (req, res) => {
    await syncAllAliases();
    res.json({
        message: 'Sincronización solicitada para todos los alias',
        lastSync: lastSyncTime
    });
});

// Endpoint de estado
app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        port: PORT,
        lastSync: lastSyncTime,
        syncInterval: `${SYNC_INTERVAL_MINUTES} minutos`,
        syncInProgress
    });
});

// Endpoint para servir el ICS
app.get('/calendar.ics', (req, res) => {
    const alias = req.query.alias || 'default';
    const aliasCache = path.join(__dirname, 'calendar-cache-' + alias + '.ics');
    if (fs.existsSync(aliasCache)) {
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.sendFile(aliasCache);
    } else {
        res.status(404).send('Archivo ICS no generado o alias inválido.');
    }
});

// Endpoint para configuración dinámica
app.get('/apiserv/config', async (req, res) => {
    try {
        const env = await getEnvFromRequest(req);
        if (!env) {
            return res.status(404).json({ error: 'Configuración no encontrada' });
        }

        const docs = db.getDocumentsByEnvironment(env.id);
        const config = {
            ...env,
            ...env.configJson,
            sources: docs.filter(d => d.type === 'ics' || d.type === 'sheet'),
            icsUrl: '/calendar.ics?alias=' + env.alias
        };

        res.json(config);
    } catch (error) {
        log(`ERROR en /apiserv/config: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para suscribirse
app.post('/apiserv/subscribe', express.json(), async (req, res) => {
    try {
        let { email, name, phone, eventId, eventTitle, alertType, acceptPrivacy, returnUrl } = req.body;
        const env = await getEnvFromRequest(req);
        
        // Detect login session
        const session = getSessionFromCookie(getCookie(req, 'admin_session'));
        const isAuthenticated = !!session;

        if (isAuthenticated) {
            email = session.email;
            acceptPrivacy = true;
        }

        eventId = (eventId === undefined || eventId === '') ? null : eventId;
        eventTitle = eventTitle === undefined ? 'General' : eventTitle;
        name = name === undefined ? null : name;
        phone = phone === undefined ? null : phone;
        returnUrl = returnUrl === undefined ? null : returnUrl;

        if (!env) return res.status(404).json({ error: 'Entorno no válido' });
        if (!email || !alertType || !acceptPrivacy) return res.status(400).json({ error: 'Email, alertType y privacidad son obligatorios' });
        
        const validTypes = ['specific', 'general', 'dashboard'];
        if (!validTypes.includes(alertType)) return res.status(400).json({ error: 'Tipo de alerta no válido' });
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Email inválido' });

        // 1. Verificar si ya existe el usuario
        let user = db.getUserByEmail(email, env.id);

        if (isAuthenticated) {
            if (!user) {
                const result = db.insertUser(env.id, email, session.username, null, null, null, returnUrl);
                user = { id: result.lastInsertRowid, email, confirmed: 1 };
                db.confirmUserManually(user.id);
            } else if (!user.confirmed) {
                db.confirmUserManually(user.id);
                user.confirmed = 1;
            }
        }

        // 2. Lógica de suscripción avanzada (Unicidad y Jerarquía)
        if (user) {
            // Si el usuario ya tiene una suscripción general en este entorno
            const hasGeneral = db.getSubscriptionByType(user.id, env.id, 'general');
            
            if (alertType === 'specific') {
                if (hasGeneral) {
                    return res.status(400).json({ error: 'Ya estás suscrito a todos los eventos' });
                }
                const hasSpecific = db.getSubscriptionByEvent(user.id, env.id, eventId);
                if (hasSpecific) {
                    return res.status(400).json({ error: 'Ya estás suscrito a este evento' });
                }
            } else if (alertType === 'general') {
                if (hasGeneral) {
                    return res.status(400).json({ error: 'Ya estás suscrito a todos los eventos' });
                }
                // Si se suscribe a todos, eliminar las individuales previas
                db.deleteSpecificSubscriptions(user.id, env.id);
            } else if (alertType === 'dashboard') {
                const hasDashboard = db.getSubscriptionByType(user.id, env.id, 'dashboard');
                if (hasDashboard) {
                    return res.status(400).json({ error: 'Ya estás suscrito a los cambios del Dashboard' });
                }
            }
        }

        if (isAuthenticated) {
            db.insertSubscription(env.id, user.id, eventId, eventTitle, alertType);
            db.insertAuditLog(env.id, session.id || 0, 'SUBSCRIBE_AUTH', 'subscription', eventId, `Usuario admin ${email} suscrito directamente.`);
            return res.json({ success: true, authenticated: true });
        }
        
        if (user && user.confirmed) {
            db.insertSubscription(env.id, user.id, eventId, eventTitle, alertType);
            db.insertAuditLog(env.id, 0, 'SUBSCRIBE_AUTO', 'subscription', eventId, `Usuario ${email} suscrito automáticamente.`);
            
            await sendSubscriptionConfirmationToUser(env, user, alertType, eventTitle);
            await notifySuperusersOfSubscription(env, user, alertType, eventTitle);
            
            return res.json({ success: true, alreadyConfirmed: true });
        }

        // 3. Generar token y guardar/actualizar usuario (Anónimo)
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const result = db.insertUser(env.id, email, name, phone, token, expires.toISOString(), returnUrl);
        const userId = result.lastInsertRowid || (user ? user.id : null);
        
        if (userId === undefined) throw new Error("userId is undefined");

        db.insertSubscription(env.id, userId, eventId, eventTitle, alertType);

        const confirmUrl = `${req.protocol}://${req.get('Host')}/confirm-email?token=${token}&config=${env.alias}`;
        await emailTransporter.sendMail({
            from: `"Notificaciones" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Confirma tu suscripción',
            html: `<h3>Confirma tu correo para activar las alertas de ${env.title}</h3>
                   <p>Has solicitado suscribirte a: <strong>${eventTitle || 'General'}</strong></p>
                   <a href="${confirmUrl}" style="background:#3498db; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; display:inline-block;">Confirmar Suscripción</a>`
        });

        res.json({ success: true, requiresConfirmation: true });
    } catch (error) {
        log(`ERROR en /apiserv/subscribe: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Endpoint para confirmar email (soporta ambos nombres por compatibilidad)
app.get(['/apiserv/confirm', '/confirm-email'], async (req, res) => {
    try {
        const { token, config } = req.query;
        if (!token) return res.status(400).send('Token requerido');

        const user = db.getUserByToken(token);
        if (!user || new Date() > new Date(user.confirmationExpires)) {
            return res.status(400).send('Token inválido o expirado');
        }

        db.confirmUser(token);
        const env = db.getEnvironmentById(user.environmentId);

        // Notificar a superusuarios sobre las nuevas suscripciones activadas
        try {
            const subs = db.getUserSubscriptions(user.id, env.id);
            for (const sub of subs) {
                await notifySuperusersOfSubscription(env, user, sub.alertType, sub.eventTitle);
            }
        } catch (err) {
            log(`Error notificando superusuarios en confirmación: ${err.message}`);
        }

        const finalRedirect = user.returnUrl || `/?config=${env.alias}`;

        res.send(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h2 style="color: #27ae60;">¡Email confirmado!</h2>
                <p>Tu suscripción en <strong>${env.title}</strong> ha sido activada.</p>
                <a href="${finalRedirect}">Volver al calendario</a>
            </div>
        `);
    } catch (error) {
        res.status(500).send('Error interno');
    }
});

// Endpoint para cancelar suscripción
app.delete('/apiserv/unsubscribe', express.json(), async (req, res) => {
    try {
        const { email, eventId, alertType } = req.body;
        const env = await getEnvFromRequest(req);
        if (!env) return res.status(404).json({ error: 'Entorno no válido' });

        const user = db.getUserByEmail(email, env.id);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        db.deleteSubscription(user.id, eventId, alertType, env.id);
        res.json({ message: 'Suscripción cancelada' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// === RUTAS DE AUTENTICACIÓN ADMIN ===
app.post('/apiserv/admin/login', express.json(), async (req, res) => {
    try {
        const { username, password, config } = req.body;
        const env = await getEnvFromRequest(req); // Usará el alias del body si existe

        // 1. Root check (Global)
        if (process.env.ADMIN_USER && username === process.env.ADMIN_USER) {
            if (bcrypt.compareSync(password, process.env.ADMIN_PASS_HASH)) {
                const targetEnv = env || db.getEnvironmentByAlias('avm146') || { id: 1 };
                const user = { id: 0, username: username, role: 'root', isSuperuser: 1, environmentId: targetEnv.id };
                res.setHeader('Set-Cookie', `admin_session=${createSessionCookie(user)}; HttpOnly; Path=/; SameSite=Strict`);
                return res.json({ success: true, user });
            }
        }

        // 2. Account check
        if (!env && !username) return res.status(400).json({ error: 'Faltan credenciales' });
        
        // Intentar buscar de forma global si no tenemos envId (login global)
        const account = db.getAccountByUsername(username, env ? env.id : null);
        if (account && bcrypt.compareSync(password, account.passwordHash)) {
            const user = { 
                id: account.id, 
                username: account.username, 
                role: account.role, 
                isSuperuser: account.isSuperuser || 0,
                email: account.email,
                environmentId: account.environmentId || (env ? env.id : 1)
            };
            res.setHeader('Set-Cookie', `admin_session=${createSessionCookie(user)}; HttpOnly; Path=/; SameSite=Strict`);
            db.insertAuditLog(user.environmentId, account.id, 'login', 'account', String(account.id), 'Login successful');
            return res.json({ success: true, user });
        }

        res.status(401).json({ error: 'Credenciales inválidas para este entorno' });
    } catch (err) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

app.post('/apiserv/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    res.json({ success: true, message: 'Sesión cerrada' });
});

app.get('/apiserv/admin/me', requireAdminAuth, (req, res) => {
    res.json(req.user);
});

// --- UPLOAD IMAGES CONFIG ---
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        let destFolder = path.join(__dirname, 'uploads');
        if (req.originalUrl.includes('/upload/logo')) {
            destFolder = path.join(destFolder, 'logos');
        } else if (req.originalUrl.includes('/upload/avatar')) {
            destFolder = path.join(destFolder, 'avatars');
        }
        
        if (!fs.existsSync(destFolder)) {
            fs.mkdirSync(destFolder, { recursive: true });
        }
        cb(null, destFolder);
    },
    filename: function(req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 500 * 1024 }, // 500kb max
    fileFilter: function (req, file, cb) {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Solo se permiten imágenes'), false);
        }
        cb(null, true);
    }
});

app.post('/apiserv/admin/upload/logo', requireRole(['root', 'admin']), upload.single('logo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });
    const publicUrl = `/uploads/logos/${req.file.filename}`;
    res.json({ success: true, url: publicUrl });
});

app.post('/apiserv/admin/upload/avatar', requireAdminAuth, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });
    const publicUrl = `/uploads/avatars/${req.file.filename}`;
    res.json({ success: true, url: publicUrl });
});

// === GESTIÓN DE ENTORNOS (Solo Superuser) ===
app.get('/apiserv/admin/environments', requireRole(['root', 'admin']), (req, res) => {
    if (!req.user.isSuperuser) return res.status(403).json({ error: 'Requiere superusuario' });
    const environments = db.getAllEnvironments();
    res.json(environments);
});

app.get('/apiserv/admin/environments/:id', requireRole(['root', 'admin']), (req, res) => {
    try {
        const env = db.getEnvironmentById(req.params.id);
        if (!env) return res.status(404).json({ error: 'Entorno no encontrado' });
        res.json(env);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/apiserv/admin/environments', requireRole(['root', 'admin']), express.json(), (req, res) => {
    if (!req.user.isSuperuser) return res.status(403).json({ error: 'Requiere superusuario' });
    const { alias, title, subtitle, googleDocSource, configJson, logoUrl } = req.body;
    try {
        const result = db.insertEnvironment(alias, { title, subtitle, googleDocSource, configJson, logoUrl });
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/apiserv/admin/environments/:id', requireRole(['root', 'admin']), express.json(), (req, res) => {
    if (!req.user.isSuperuser) return res.status(403).json({ error: 'Requiere superusuario' });
    const { title, subtitle, googleDocSource, configJson, logoUrl } = req.body;
    try {
        db.updateEnvironment(req.params.id, title, subtitle, googleDocSource, configJson, logoUrl);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/apiserv/admin/environments/:id', requireRole(['root', 'admin']), (req, res) => {
    if (!req.user.isSuperuser) return res.status(403).json({ error: 'Requiere superusuario' });
    try {
        db.deleteEnvironment(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === GESTIÓN DE DOCUMENTOS (Root / Propios) ===
app.get('/apiserv/admin/documents', requireRole(['root', 'admin']), (req, res) => {
    try {
        if (!req.user.isSuperuser) return res.status(403).json({ error: 'Requiere superusuario' });
        const docs = db.getAllDocuments();
        res.json(docs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/apiserv/admin/documents/:id', requireRole(['root', 'admin']), (req, res) => {
    try {
        const doc = db.getDocumentById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
        if (!req.user.isSuperuser && doc.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }
        res.json(doc);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/apiserv/admin/environments/:envId/documents', requireRole(['root', 'admin']), (req, res) => {
    if (!req.user.isSuperuser && parseInt(req.params.envId) !== req.user.envId) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const docs = db.getDocumentsByEnvironment(req.params.envId);
    res.json(docs);
});

app.post('/apiserv/admin/environments/:envId/documents', requireRole(['root', 'admin']), express.json(), (req, res) => {
    if (!req.user.isSuperuser && parseInt(req.params.envId) !== req.user.envId) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const { type, label, url, color, metadata } = req.body;
    try {
        const result = db.insertDocument(req.params.envId, type, label, url, color, metadata);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/apiserv/admin/documents/:id', requireRole(['root', 'admin']), express.json(), (req, res) => {
    const { type, label, url, color, metadata } = req.body;
    try {
        const doc = db.getDocumentById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
        if (!req.user.isSuperuser && doc.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }
        db.updateDocument(req.params.id, type, label, url, color, metadata);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/apiserv/admin/documents/:id', requireRole(['root', 'admin']), (req, res) => {
    try {
        const doc = db.getDocumentById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
        if (!req.user.isSuperuser && doc.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }
        db.deleteDocument(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === GESTIÓN DE CUENTAS (Solo Root y Admin) ===
app.get('/apiserv/admin/accounts', requireRole(['root', 'admin']), (req, res) => {
    const accounts = db.getAllAccounts(req.user.envId, req.user.isSuperuser);
    res.json(accounts);
});

app.post('/apiserv/admin/accounts', requireRole(['root', 'admin']), express.json(), (req, res) => {
    const { username, password, role, isSuperuser, email, accessLevel, profileData, firstName, lastName, avatarUrl } = req.body;
    const envId = req.user.envId;
    
    if (!username || !password || !role) {
        return res.status(400).json({ error: 'Datos incompletos' });
    }

    if (!req.user.isSuperuser && isSuperuser) {
        return res.status(403).json({ error: 'No puedes crear un superusuario' });
    }

    if (db.getAccountByUsername(username, envId)) {
        return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    }

    try {
        const passwordHash = bcrypt.hashSync(password, 10);
        const fullName = [firstName, lastName].filter(Boolean).join(' ');
        const result = db.insertAccount(
            envId, username, passwordHash, role, isSuperuser ? 1 : 0, 
            accessLevel || 1, profileData || {}, email, 
            firstName || null, lastName || null, fullName || null, null, avatarUrl || null
        );
        db.insertAuditLog(envId, req.user.id, 'create', 'account', String(result.lastInsertRowid), `Created ${role}: ${username}`);

        if (req.body.sendNotify && email) {
            const env = db.getEnvironmentById(envId);
            const accessUrl = getAccessUrl(req, env);
            const subject = `Nueva cuenta administrativa - ${env.title}`;
            const body = `
                <h2>Bienvenido, ${username}</h2>
                <p>Se ha creado una cuenta para ti en el sistema de Calendario ${env.title}.</p>
                <p><strong>Usuario:</strong> ${username}</p>
                <p><strong>Contraseña:</strong> ${password}</p>
                <p>Acceso: <a href="${accessUrl}">Iniciar Sesión</a></p>
            `;
            sendNotificationEmail(email, subject, body);
        }

        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: 'Error al crear cuenta: ' + e.message });
    }
});

// Obtener una cuenta específica para edición
app.get('/apiserv/admin/accounts/:id', requireAdminAuth, (req, res) => {
    const accountId = req.params.id;
    // Permitir si es admin/root O si es su propia cuenta
    if (req.user.role !== 'root' && req.user.role !== 'admin' && String(req.user.id) !== String(accountId)) {
        return res.status(403).json({ error: 'No tienes permiso para ver esta cuenta' });
    }

    const account = db.getAccountById(accountId);
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' });
    
    // No enviar el passwordHash al frontend
    const { passwordHash, ...safeAccount } = account;
    res.json(safeAccount);
});

// Actualizar cuenta existente
app.put('/apiserv/admin/accounts/:id', requireAdminAuth, express.json(), (req, res) => {
    const accountId = req.params.id;
    
    // Permitir si es admin/root O si es su propia cuenta
    if (req.user.role !== 'root' && req.user.role !== 'admin' && String(req.user.id) !== String(accountId)) {
        return res.status(403).json({ error: 'No tienes permiso para editar esta cuenta' });
    }

    try {
        const envId = req.user.envId;
        const { password, role, isSuperuser, email, accessLevel, profileData, firstName, lastName, interface_Prefs, avatarUrl } = req.body;
        const currentAccount = db.getAccountById(accountId);
        
        if (!currentAccount) {
            return res.status(404).json({ error: 'Cuenta no encontrada' });
        }

        // Restricción de alcance para admins (no root)
        if (req.user.role === 'admin' && !req.user.isSuperuser && currentAccount.environmentId !== envId) {
             return res.status(403).json({ error: 'Fuera de alcance' });
        }

        // Solo root puede cambiar Roles o Superuser status (Requerimiento del usuario)
        let finalRole = currentAccount.role;
        let finalIsSuperuser = currentAccount.isSuperuser;

        if (req.user.role === 'root') {
            finalRole = role || currentAccount.role;
            finalIsSuperuser = (isSuperuser !== undefined) ? (isSuperuser ? 1 : 0) : currentAccount.isSuperuser;
        }

        const passwordHash = password ? bcrypt.hashSync(password, 10) : currentAccount.passwordHash;
        
        const finalFirstName = firstName !== undefined ? firstName : currentAccount.firstName;
        const finalLastName = lastName !== undefined ? lastName : currentAccount.lastName;
        const finalFullName = [finalFirstName, finalLastName].filter(Boolean).join(' ');
        
        // Mantener avatarUrl actual si no se provee uno nuevo en el payload (útil para updates parciales)
        const finalAvatarUrl = avatarUrl !== undefined ? avatarUrl : currentAccount.avatarUrl;

        db.updateAccount(
            accountId, passwordHash, finalRole, finalIsSuperuser, 
            accessLevel || currentAccount.accessLevel, 
            profileData || JSON.parse(currentAccount.profileData || '{}'), 
            email || currentAccount.email,
            finalFirstName || null, finalLastName || null, finalFullName || null,
            interface_Prefs !== undefined ? (typeof interface_Prefs === 'string' ? interface_Prefs : JSON.stringify(interface_Prefs)) : currentAccount.interface_Prefs,
            finalAvatarUrl
        );
        
        db.insertAuditLog(currentAccount.environmentId, req.user.id, 'update', 'account', accountId, `Updated user ${accountId} (Self: ${req.user.id == accountId})`);

        if (req.body.sendNotify && email && password) {
            const env = db.getEnvironmentById(envId);
            const accessUrl = getAccessUrl(req, env);
            const subject = `Actualización de credenciales - ${env.title}`;
            const body = `
                <h2>Hola ${currentAccount.username},</h2>
                <p>Se han actualizado tus credenciales de acceso al Calendario ${env.title}.</p>
                <p><strong>Nueva Contraseña:</strong> ${password}</p>
                <p>Acceso: <a href="${accessUrl}">Iniciar Sesión</a></p>
            `;
            sendNotificationEmail(email, subject, body);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al actualizar cuenta: ' + e.message });
    }
});

// Actualizar PREFERENCIAS de interfaz (interface_Prefs)
app.put('/apiserv/admin/accounts/:id/prefs', requireAdminAuth, express.json(), (req, res) => {
    const accountId = req.params.id;
    // Solo el dueño de la cuenta o root pueden cambiar sus propias preferencias (admins también si es de su env)
    if (req.user.role !== 'root' && req.user.role !== 'admin' && String(req.user.id) !== String(accountId)) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    try {
        const { interface_Prefs } = req.body;
        db.updateAccountPrefs(accountId, interface_Prefs);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/apiserv/admin/accounts/:id', requireRole(['root', 'admin']), (req, res) => {
    const targetId = req.params.id;
    const envId = req.user.envId;
    const target = db.getAccountById(targetId);

    if (!target || (req.user.role !== 'root' && target.environmentId !== envId)) {
        return res.status(404).json({ error: 'Cuenta no encontrada' });
    }
    if (target.role === 'root' && req.user.role !== 'root') {
        return res.status(403).json({ error: 'No puedes eliminar a un superusuario' });
    }

    db.deleteAccount(targetId, envId);
    db.insertAuditLog(envId, req.user.id, 'delete', 'account', targetId, `Deleted account: ${target.username}`);
    res.json({ success: true });
});

// === AUDIT LOGS ===
app.get('/apiserv/admin/audit-logs', requireRole(['root']), (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const envId = req.user.envId; 
    const logs = db.getAuditLogs(envId, req.user.isSuperuser, limit, offset);
    res.json(logs);
});

// Endpoint para datos de infografía (solo admin y colaborador)
app.get('/apiserv/admin/infographic-data', requireRole(['root', 'admin', 'colaborator']), async (req, res) => {
    try {
        const env = await getEnvFromRequest(req);
        if (!env) return res.status(404).json({ error: 'Entorno no encontrado' });

        const config = { ...env, ...env.configJson };
        const configAlias = env.alias;
        
        let docContent = '';
        let dynamicLinks = [];

        // 1. Cargar links desde la base de datos (NUEVO SISTEMA)
        const docs = db.getDocumentsByEnvironment(env.id);
        const infographicDocs = docs.filter(d => d.type === 'infographic');
        
        infographicDocs.forEach(d => {
            if (d.metadata) {
                try {
                    const meta = typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata;
                    if (meta.infographicLinks && Array.isArray(meta.infographicLinks)) {
                        dynamicLinks = [...dynamicLinks, ...meta.infographicLinks];
                    }
                } catch (e) {}
            }
        });

        // 2. Cargar contenido/resumen desde caché de archivo (LEGACY/HYBRID)
        // Por ahora asumimos que el primer documento de tipo infographic aporta el contenido textual principal
        // O usamos el cache legacy si existe para compatibilidad
        const cachePath = path.join(__dirname, `infographic-cache-${configAlias}.json`);
        if (fs.existsSync(cachePath)) {
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            docContent = cacheData.docContent || '';
            // Si no encontramos nada en DB metadata, caemos a los links del cache legacy
            if (dynamicLinks.length === 0) {
                dynamicLinks = cacheData.dynamicLinks || [];
            }
        }

        const finalLinks = dynamicLinks.length > 0 ? dynamicLinks : (config.infographicLinks || []);
        const docUrl = config.googleDocSource ? config.googleDocSource.split('/export')[0] : (infographicDocs.length > 0 ? infographicDocs[0].url.split('/export')[0] : null);

        return res.json({ 
            links: finalLinks, 
            docContent: docContent,
            docUrl: docUrl
        });
    } catch (error) {
        log(`ERROR en /apiserv/admin/infographic-data: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// === PANEL DE ADMINISTRACIÓN ===

// Página principal del admin
app.get('/admin', requireAdminAuth, (req, res) => {
    const envId = req.user.envId;
    const users = db.getUserWithSubscriptions(envId, req.user.isSuperuser);
    const searchParams = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?')[1] : '';

    let html = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Panel de Administración - Calendario AVM146</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                body { background-color: #f8f9fa; }
                .container { max-width: 1200px; margin: 2rem auto; }
                .user-card { margin-bottom: 1rem; }
                .subscription-item { background: #f8f9fa; padding: 0.5rem; margin: 0.25rem 0; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="d-flex justify-content-between align-items-center mb-4">
                    <h1>Panel de Administración</h1>
                    <div>
                        <a href="/${searchParams}" class="btn btn-secondary me-2">Calendario</a>
                        <button class="btn btn-outline-danger" onclick="logoutAdmin()">Cerrar sesión</button>
                    </div>
                </div>

                <div class="row">
                    <div class="col-md-12">
                        <div class="card">
                            <div class="card-header">
                                <h5>Usuarios Suscritos (${users.length})</h5>
                            </div>
                            <div class="card-body">
    `;

    users.forEach(user => {
        const subscriptions = user.subscriptions ? user.subscriptions.split(',').map(sub => {
            const [eventId, alertType, createdAt] = sub.split('|');
            return { eventId, alertType, createdAt };
        }) : [];

        html += `
            <div class="user-card card">
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-6">
                            <h6>${user.name || 'Sin nombre'} <small class="text-muted">(${user.email})</small></h6>
                            <p class="mb-1"><strong>Teléfono:</strong> ${user.phone || 'No especificado'}</p>
                            <p class="mb-1"><strong>Estado:</strong>
                                <span class="badge ${user.confirmed ? 'bg-success' : 'bg-warning'}">
                                    ${user.confirmed ? 'Confirmado' : 'Pendiente'}
                                </span>
                            </p>
                            <p class="mb-1"><strong>Registrado:</strong> ${new Date(user.createdAt).toLocaleDateString('es-ES')}</p>
                        </div>
                        <div class="col-md-6">
                            <h6>Suscripciones (${subscriptions.length})</h6>
                            ${subscriptions.length > 0 ?
                subscriptions.map(sub => `
                                    <div class="subscription-item">
                                        <small>
                                            <strong>${sub.alertType === 'general' ? 'General' : 'Evento específico'}</strong>
                                            ${sub.eventId ? ` - ${sub.eventId}` : ''}
                                            <br>
                                            <span class="text-muted">${new Date(sub.createdAt).toLocaleDateString('es-ES')}</span>
                                        </small>
                                    </div>
                                `).join('') :
                '<small class="text-muted">Sin suscripciones activas</small>'
            }
                        </div>
                    </div>
                    <div class="mt-3">
                        <button class="btn btn-sm btn-outline-primary" onclick="editUser(${user.id})">Editar</button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteUser(${user.id})">Eliminar</button>
                    </div>
                </div>
            </div>
        `;
    });

    html += `
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                function logoutAdmin() {
                    fetch('/apiserv/admin/logout', { method: 'POST' })
                        .then(() => window.location.href = '/' + window.location.search);
                }

                function editUser(userId) {
                    fetch('/admin/users/' + userId)
                    .then(response => {
                        if (!response.ok) throw new Error('Error HTTP ' + response.status);
                        return response.json();
                    })
                    .then(user => {
                        if (user.error) throw new Error(user.error);
                        // Crear modal de edición
                        const modalHtml = \`
                            <div class="modal fade" id="editUserModal" tabindex="-1">
                                <div class="modal-dialog">
                                    <div class="modal-content">
                                        <div class="modal-header">
                                            <h5 class="modal-title">Editar Usuario</h5>
                                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                                        </div>
                                        <div class="modal-body">
                                            <form id="editUserForm">
                                                <div class="mb-3">
                                                    <label for="editEmail" class="form-label">Email</label>
                                                    <input type="email" class="form-control" id="editEmail" value="\${user.email || ''}" required>
                                                </div>
                                                <div class="mb-3">
                                                    <label for="editName" class="form-label">Nombre</label>
                                                    <input type="text" class="form-control" id="editName" value="\${user.name || ''}">
                                                </div>
                                                <div class="mb-3">
                                                    <label for="editPhone" class="form-label">Teléfono</label>
                                                    <input type="tel" class="form-control" id="editPhone" value="\${user.phone || ''}">
                                                </div>
                                            </form>
                                        </div>
                                        <div class="modal-footer">
                                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
                                            <button type="button" class="btn btn-primary" id="saveUserChanges">Guardar</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        \`;

                        // Agregar modal al DOM
                        document.body.insertAdjacentHTML('beforeend', modalHtml);

                        // Mostrar modal
                        const modal = new bootstrap.Modal(document.getElementById('editUserModal'));
                        modal.show();

                        // Manejar guardado
                        document.getElementById('saveUserChanges').addEventListener('click', () => {
                            const form = document.getElementById('editUserForm');
                            if (!form.checkValidity()) {
                                form.reportValidity();
                                return;
                            }

                            const email = document.getElementById('editEmail').value;
                            const name = document.getElementById('editName').value;
                            const phone = document.getElementById('editPhone').value;

                            fetch('/admin/users/' + userId, {
                                method: 'PUT',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({ email, name, phone })
                            })
                            .then(response => response.json())
                            .then(data => {
                                alert(data.message);
                                modal.hide();
                                location.reload();
                            })
                            .catch(error => alert('Error al actualizar usuario'));
                        });

                        // Limpiar modal cuando se cierre
                        document.getElementById('editUserModal').addEventListener('hidden.bs.modal', () => {
                            document.getElementById('editUserModal').remove();
                        });
                    })
                    .catch(error => alert('Error al obtener datos del usuario: ' + error.message));
                }

                function deleteUser(userId) {
                    if (confirm('¿Estás seguro de que quieres eliminar este usuario?')) {
                        fetch('/admin/users/' + userId, {
                            method: 'DELETE'
                        })
                        .then(response => {
                            if (!response.ok) throw new Error('Error HTTP ' + response.status);
                            return response.json();
                        })
                        .then(data => {
                            if (data.error) throw new Error(data.error);
                            alert(data.message);
                            location.reload();
                        })
                        .catch(error => alert('Error al eliminar usuario: ' + error.message));
                    }
                }
            </script>
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
        </body>
        </html>
    `;

    res.send(html);
});

// API para obtener usuario por ID (admin)
app.get('/admin/users/:id', requireAdminAuth, (req, res) => {
    try {
        const userId = req.params.id;
        const envId = req.user.envId;
        const user = db.getUserById(userId, envId);
        
        // Si es superusuario y no lo encontró en el env actual, intentar global (o simplemente permitir si envId coincide)
        if (!user && req.user.isSuperuser) {
            // Podríamos añadir un getUserById global, pero de momento asumimos que el frontend pasa el envId o similar
        }

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json(user);
    } catch (error) {
        log(`ERROR obteniendo usuario: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// API para editar usuario (admin)
app.put('/admin/users/:id', requireAdminAuth, express.json(), (req, res) => {
    try {
        const userId = req.params.id;
        const { name, phone, email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email es obligatorio' });
        }

        // Validar email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Email inválido' });
        }

        const envId = req.user.envId;
        db.updateUser(userId, envId, name, phone, email);
        db.insertAuditLog(envId, req.user.id, 'update', 'subscriber', String(userId), `Updated subscriber: ${email}`);

        res.json({ message: 'Usuario actualizado exitosamente' });
    } catch (error) {
        log(`ERROR actualizando usuario: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// API para eliminar usuario (admin)
app.delete('/admin/users/:id', requireAdminAuth, (req, res) => {
    try {
        const userId = req.params.id;
        const envId = req.user.envId;
        const user = db.getUserById(userId, envId);
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        db.deleteSubscriptionsByUserId(userId, envId);
        db.deleteUser(userId, envId);
        db.insertAuditLog(envId, req.user.id, 'delete', 'subscriber', String(userId), `Deleted subscriber: ${user.email}`);

        res.json({ message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        log(`ERROR eliminando usuario: ${error.message}`);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// API para obtener suscripciones con nombres de eventos (admin)
app.get('/apiserv/admin/subscriptions', requireAdminAuth, (req, res) => {
    try {
        const envId = req.user.envId;
        let subscriptions;
        if (req.user.role === 'user' && !req.user.isSuperuser) {
            if (!req.user.email) return res.json([]);
            subscriptions = db.getSubscriptionsByEmail(req.user.email, envId);
        } else {
            subscriptions = db.getAllSubscriptions(envId, req.user.isSuperuser);
        }
        
        const enriched = subscriptions.map(sub => ({
            ...sub,
            eventTitle: sub.eventId ? (globalEventTitles[sub.eventId] || `ID: ${sub.eventId}`) : 'Todos los eventos'
        }));

        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/apiserv/admin/subscriptions/:id', requireAdminAuth, (req, res) => {
    try {
        const sub = db.getSubscriptionById(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Suscripción no encontrada' });
        
        if (!req.user.isSuperuser && sub.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        sub.eventTitle = sub.eventId ? (globalEventTitles[sub.eventId] || `ID: ${sub.eventId}`) : 'Todos los eventos';
        res.json(sub);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Editar suscripción (admin)
app.put('/apiserv/admin/subscriptions/:id', requireAdminAuth, express.json(), (req, res) => {
    try {
        const { alertType } = req.body;
        const sub = db.getSubscriptionById(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Suscripción no encontrada' });

        if (!req.user.isSuperuser && sub.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        db.updateSubscription(req.params.id, alertType);
        db.insertAuditLog(req.user.envId, req.user.id, 'update', 'subscription', req.params.id, `Updated alertType to ${alertType}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Eliminar suscripción (admin)
app.delete('/apiserv/admin/subscriptions/:id', requireAdminAuth, (req, res) => {
    try {
        const sub = db.getSubscriptionById(req.params.id);
        if (!sub) return res.status(404).json({ error: 'Suscripción no encontrada' });

        if (!req.user.isSuperuser && sub.environmentId !== req.user.envId) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        db.deleteSubscriptionById(req.params.id, sub.environmentId);
        db.insertAuditLog(req.user.envId, req.user.id, 'delete', 'subscription', req.params.id, `Deleted subscription for ${sub.email}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para cerrar sesión
app.post('/apiserv/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict');
    res.json({ success: true });
});

// Servir archivos estáticos (HTML, CSS, JS, etc)
app.use(express.static(__dirname, {
    maxAge: 0,
    etag: true
}));

// Redirigir raíz a index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
    log(`Servidor corriendo en http://localhost:${PORT}`);
    log(`Archivos estáticos servidos desde: ${__dirname}`);
    log(`Endpoint ICS: http://localhost:${PORT}/calendar.ics`);
    log(`Endpoint status: http://localhost:${PORT}/status`);
});

// Sincronización inicial al iniciar
(async () => {
    log('Iniciando sincronización primera...');
    await syncAllAliases();
})();

// Programar sincronización periódica
if (ICS_SOURCE_URL) {
    const cronExpression = `*/${SYNC_INTERVAL_MINUTES} * * * *`;
    cron.schedule(cronExpression, async () => {
        log(`Ejecutando sincronización periódica (cada ${SYNC_INTERVAL_MINUTES} min)...`);
        await syncAllAliases();
    });
    log(`✓ Sincronización periódica programada: cada ${SYNC_INTERVAL_MINUTES} minutos`);
}
