const fs = require('fs');
const path = require('path');
const db = require('./database');

async function migrate() {
    console.log("Iniciando migración a entornos...");

    const configsPath = path.join(__dirname, 'configs.json');
    if (!fs.existsSync(configsPath)) {
        console.log("No se encontró configs.json, abortando migración de configuración.");
        return;
    }

    const configs = JSON.parse(fs.readFileSync(configsPath, 'utf-8'));
    let avm146Id = null;

    for (const config of configs) {
        console.log(`Procesando alias: ${config.alias}`);
        const existing = db.getEnvironmentByAlias(config.alias);
        
        const configJson = {
            sources: config.sources,
            ganttGroupSeparators: config.ganttGroupSeparators,
            madridHolidays: config.madridHolidays,
            infographicLinks: config.infographicLinks
        };

        if (existing) {
            console.log(`El entorno ${config.alias} ya existe (ID: ${existing.id}). Actualizando...`);
            db.updateEnvironment(existing.id, config.titulo, config.subtitulo, config.googleDocSource, configJson);
            if (config.alias === 'avm146') avm146Id = existing.id;
        } else {
            console.log(`Creando entorno ${config.alias}...`);
            const result = db.insertEnvironment(config.alias, config.titulo, config.subtitulo, config.googleDocSource, configJson);
            if (config.alias === 'avm146') avm146Id = result.lastInsertRowid;
            console.log(`Entorno ${config.alias} creado con ID: ${result.lastInsertRowid}`);
        }
    }

    if (!avm146Id) {
        // Fallback si no existe avm146, usar el primero o default
        const firstEnv = db.getAllEnvironments()[0];
        if (firstEnv) avm146Id = firstEnv.id;
    }

    if (avm146Id) {
        console.log(`Vinculando todos los registros existentes al entorno ID: ${avm146Id} (avm146)`);
        
        // Usar la instancia interna de db para ejecutar SQL de migración directa
        // Accedemos a la base de datos de better-sqlite3
        const sqliteDb = require('better-sqlite3')(path.join(__dirname, 'subscriptions.db'));
        
        sqliteDb.prepare("UPDATE users SET environmentId = ? WHERE environmentId IS NULL").run(avm146Id);
        sqliteDb.prepare("UPDATE subscriptions SET environmentId = ? WHERE environmentId IS NULL").run(avm146Id);
        sqliteDb.prepare("UPDATE accounts SET environmentId = ? WHERE environmentId IS NULL").run(avm146Id);
        sqliteDb.prepare("UPDATE audit_logs SET environmentId = ? WHERE environmentId IS NULL").run(avm146Id);
        
        console.log("Migración de registros completada.");
        sqliteDb.close();
    } else {
        console.log("ERROR: No se pudo determinar un ID de entorno para la migración de registros.");
    }

    console.log("Migración finalizada con éxito.");
}

migrate().catch(err => {
    console.error("Error durante la migración:", err);
    process.exit(1);
});
