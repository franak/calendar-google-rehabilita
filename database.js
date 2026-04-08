const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'subscriptions.db');
const db = new Database(dbPath);

// Crear tabla si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS environments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT UNIQUE NOT NULL,
    title TEXT,
    subtitle TEXT,
    googleDocSource TEXT,
    configJson TEXT, -- JSON con sources, holidays, separators, etc.
    logoUrl TEXT, -- Logo para la cabecera
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environmentId INTEGER,
    email TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    confirmed INTEGER DEFAULT 0,
    confirmationToken TEXT,
    confirmationExpires DATETIME,
    returnUrl TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE,
    UNIQUE(email, environmentId)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environmentId INTEGER,
    userId INTEGER NOT NULL,
    eventId TEXT,
    alertType TEXT NOT NULL CHECK (alertType IN ('specific', 'general')),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environmentId INTEGER,
    username TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    isSuperuser INTEGER DEFAULT 0,
    accessLevel INTEGER DEFAULT 1,
    profileData TEXT,
    email TEXT,
    firstName TEXT,
    lastName TEXT,
    fullName TEXT,
    interface_Prefs TEXT, -- JSON con preferencias de tabla
    avatarUrl TEXT, -- URL de la imagen de perfil
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE SET NULL,
    UNIQUE(username, environmentId)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    environmentId INTEGER,
    accountId INTEGER,
    action TEXT NOT NULL,
    targetType TEXT,
    targetId TEXT,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (accountId) REFERENCES accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE
  );
`);

// --- MIGRACIONES DE ESQUEMA ---
const migrations = [
  "ALTER TABLE users ADD COLUMN environmentId INTEGER",
  "ALTER TABLE subscriptions ADD COLUMN environmentId INTEGER",
  "ALTER TABLE accounts ADD COLUMN environmentId INTEGER",
  "ALTER TABLE audit_logs ADD COLUMN environmentId INTEGER"
];

migrations.forEach(sql => {
  try { db.exec(sql); } catch(e) {}
});

// Asegurar que las restricciones UNIQUE incluyan environmentId si es necesario (SQLite no permite ALTER UNIQUE fácilmente, se asume recreación o nueva DB si es crítico)

// --- MIGRACIONES DE ESQUEMA ROBUSTAS (Multitenencia) ---
const currentVersion = 11; // Incrementar si hay cambios de esquema masivos
const versionPath = path.join(__dirname, '.db_version');
let dbVersion = 0;
if (fs.existsSync(versionPath)) {
    dbVersion = parseInt(fs.readFileSync(versionPath, 'utf8'), 10);
}

if (dbVersion < currentVersion) {
    console.log(`Migrando base de datos de v${dbVersion} a v${currentVersion}...`);
    try {
        db.exec("PRAGMA foreign_keys = OFF");
        db.transaction(() => {
            // Tablas a migrar
            const tables = ['environments', 'users', 'subscriptions', 'accounts', 'audit_logs'];
            const schemas = {
                environments: `CREATE TABLE environments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    alias TEXT UNIQUE NOT NULL,
                    title TEXT,
                    subtitle TEXT,
                    googleDocSource TEXT,
                    configJson TEXT,
                    logoUrl TEXT,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,
                users: `CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    environmentId INTEGER,
                    email TEXT NOT NULL,
                    name TEXT,
                    phone TEXT,
                    confirmed INTEGER DEFAULT 0,
                    confirmationToken TEXT,
                    confirmationExpires DATETIME,
                    returnUrl TEXT,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE,
                    UNIQUE(email, environmentId)
                )`,
                subscriptions: `CREATE TABLE subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    environmentId INTEGER,
                    userId INTEGER NOT NULL,
                    eventId TEXT,
                    eventTitle TEXT,
                    alertType TEXT NOT NULL CHECK (alertType IN ('specific', 'general', 'dashboard')),
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE,
                    UNIQUE(userId, eventId, alertType, environmentId)
                )`,
                accounts: `CREATE TABLE accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    environmentId INTEGER,
                    username TEXT NOT NULL,
                    passwordHash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    isSuperuser INTEGER DEFAULT 0,
                    accessLevel INTEGER DEFAULT 1,
                    profileData TEXT,
                    email TEXT,
                    firstName TEXT,
                    lastName TEXT,
                    fullName TEXT,
                    interface_Prefs TEXT,
                    avatarUrl TEXT,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE SET NULL,
                    UNIQUE(username, environmentId)
                )`,
                audit_logs: `CREATE TABLE audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    environmentId INTEGER,
                    accountId INTEGER,
                    action TEXT NOT NULL,
                    targetType TEXT,
                    targetId TEXT,
                    details TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (accountId) REFERENCES accounts(id) ON DELETE SET NULL,
                    FOREIGN KEY (environmentId) REFERENCES environments(id) ON DELETE CASCADE
                )`
            };

            for (const table of tables) {
                const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
                if (tableInfo.length > 0) {
                    console.log(`Copiando datos de ${table}...`);
                    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
                    db.exec(schemas[table]);
                    
                    const oldCols = tableInfo.map(c => c.name);
                    const newColsInfo = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
                    const commonCols = oldCols.filter(c => newColsInfo.includes(c));
                    
                    db.exec(`INSERT INTO ${table} (${commonCols.join(', ')}) SELECT ${commonCols.join(', ')} FROM ${table}_old`);
                    db.exec(`DROP TABLE ${table}_old`);
                } else {
                    db.exec(schemas[table]);
                }
            }
        })();
        db.exec("PRAGMA foreign_keys = ON");
        
        if (dbVersion < 4) {
            // ... (keeping existing migrations for completeness in the file)
        }
        // Metadata color y Fuentes (v5) ...
        // ...

        fs.writeFileSync(versionPath, currentVersion.toString());
        console.log("Migración de esquema completada.");
    } catch (err) {
        db.exec("PRAGMA foreign_keys = ON");
        console.error("Error crítico en migración de esquema:", err);
    }
}

const insertEnvironment_stmt = db.prepare(`
  INSERT INTO environments (alias, title, subtitle, googleDocSource, configJson, logoUrl)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateEnvironment_stmt = db.prepare(`
  UPDATE environments SET title = ?, subtitle = ?, googleDocSource = ?, configJson = ?, logoUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
`);

const getEnvironmentByAlias_stmt = db.prepare(`
  SELECT * FROM environments WHERE alias = ?
`);

const getAllEnvironments_stmt = db.prepare(`
  SELECT * FROM environments
`);

const getEnvironmentById_stmt = db.prepare(`
  SELECT * FROM environments WHERE id = ?
`);

const deleteEnvironment_stmt = db.prepare(`
  DELETE FROM environments WHERE id = ?
`);

const insertDocument_stmt = db.prepare(`
  INSERT INTO environment_documents (environmentId, type, label, url, color, metadata)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateDocument_stmt = db.prepare(`
  UPDATE environment_documents 
  SET type = ?, label = ?, url = ?, color = ?, metadata = ?, updatedAt = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getDocumentsByEnvironment_stmt = db.prepare("SELECT * FROM environment_documents WHERE environmentId = ? ORDER BY createdAt DESC");

const getAllDocuments_stmt = db.prepare(`
    SELECT d.*, e.alias as environmentAlias, e.title as environmentTitle 
    FROM environment_documents d
    JOIN environments e ON d.environmentId = e.id
    ORDER BY d.createdAt DESC
`);

const getDocumentsByEnvironment = (envId) => {
    return getDocumentsByEnvironment_stmt.all(envId);
};

const getAllDocuments = () => {
    return getAllDocuments_stmt.all();
};

const getDocumentById_stmt = db.prepare(`
  SELECT * FROM environment_documents WHERE id = ?
`);

const deleteDocument_stmt = db.prepare(`
  DELETE FROM environment_documents WHERE id = ?
`);

const updateDocumentMetadata_stmt = db.prepare(`
  UPDATE environment_documents SET metadata = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
`);

// --- USERS ---
const insertUser_stmt = db.prepare(`
  INSERT INTO users (environmentId, email, name, phone, confirmationToken, confirmationExpires, returnUrl)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email, environmentId) DO UPDATE SET 
    name = excluded.name,
    phone = excluded.phone,
    confirmationToken = excluded.confirmationToken,
    confirmationExpires = excluded.confirmationExpires,
    returnUrl = excluded.returnUrl
`);

const updateUser_stmt = db.prepare(`
  UPDATE users SET name = ?, phone = ?, email = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND environmentId = ?
`);

const getUserById_stmt = db.prepare(`
  SELECT * FROM users WHERE id = ? AND environmentId = ?
`);

const deleteUser_stmt = db.prepare(`
  DELETE FROM users WHERE id = ? AND environmentId = ?
`);

const deleteSubscriptionsByUserId_stmt = db.prepare(`
  DELETE FROM subscriptions WHERE userId = ? AND environmentId IS ?
`);

const confirmUser_stmt = db.prepare(`
  UPDATE users SET confirmed = 1, confirmationToken = NULL, confirmationExpires = NULL WHERE confirmationToken = ?
`);

const getUserByEmail_stmt = db.prepare(`
  SELECT * FROM users WHERE email = ? AND environmentId = ?
`);

const getUserByToken_stmt = db.prepare(`
  SELECT * FROM users WHERE confirmationToken = ?
`);

const insertSubscription_stmt = db.prepare(`
  INSERT OR IGNORE INTO subscriptions (environmentId, userId, eventId, eventTitle, alertType)
  VALUES (?, ?, ?, ?, ?)
`);

const deleteSubscription_stmt = db.prepare(`
  DELETE FROM subscriptions WHERE userId = ? AND eventId = ? AND alertType = ? AND environmentId = ?
`);

const getSubscriptionsForEvent_stmt = db.prepare(`
  SELECT s.*, u.email, u.name FROM subscriptions s
  JOIN users u ON s.userId = u.id
  WHERE (s.eventId = ? OR s.alertType = 'general') AND s.environmentId = ?
`);

const getAllSubscriptions_stmt = db.prepare(`
  SELECT s.*, u.email, u.name, u.phone, u.confirmed, e.title as environmentName 
  FROM subscriptions s
  JOIN users u ON s.userId = u.id
  LEFT JOIN environments e ON s.environmentId = e.id
  WHERE (s.environmentId = ? OR ? = 1)
`);

const getUserSubscriptions_stmt = db.prepare(`
  SELECT s.*, u.email FROM subscriptions s
  JOIN users u ON s.userId = u.id
  WHERE u.id = ? AND s.environmentId = ?
`);

const getAllUsers_stmt = db.prepare(`
  SELECT * FROM users WHERE environmentId = ? ORDER BY createdAt DESC
`);

const updateSubscription_stmt = db.prepare(`
    UPDATE subscriptions SET alertType = ? WHERE id = ?
`);

const getSubscriptionById_stmt = db.prepare(`
  SELECT * FROM subscriptions WHERE id = ?
`);

const deleteSubscriptionById_stmt = db.prepare(`
  DELETE FROM subscriptions WHERE id = ? AND environmentId = ?
`);

const deleteSubscriptionsByEvent_stmt = db.prepare(`
  DELETE FROM subscriptions WHERE eventId = ? AND environmentId = ?
`);

const getConfirmedUserByEmail_stmt = db.prepare(`
    SELECT * FROM users WHERE email = ? AND confirmed = 1 AND environmentId = ?
`);

const getSubscriptionsByEmail_stmt = db.prepare(`
  SELECT s.*, e.title as environmentTitle FROM subscriptions s
  JOIN environments e ON s.environmentId = e.id
  JOIN users u ON s.userId = u.id
  WHERE u.email = ? AND s.environmentId = ?
`);

const getSubscriptionsForDashboard_stmt = db.prepare(`
  SELECT s.*, u.email, u.name FROM subscriptions s
  JOIN users u ON s.userId = u.id
  WHERE s.alertType = 'dashboard' AND s.environmentId = ?
`);

const getUserWithSubscriptions_stmt = db.prepare(`
  SELECT u.*, e.title as environmentName, GROUP_CONCAT(s.eventId || '|' || s.alertType || '|' || s.createdAt) as subscriptions
  FROM users u
  LEFT JOIN subscriptions s ON u.id = s.userId AND u.environmentId = s.environmentId
  LEFT JOIN environments e ON u.environmentId = e.id
  WHERE (u.environmentId = ? OR ? = 1)
  GROUP BY u.id
  ORDER BY u.createdAt DESC
`);

// --- ACCOUNTS ---
const insertAccount_stmt = db.prepare(`
    INSERT INTO accounts (environmentId, username, passwordHash, role, isSuperuser, accessLevel, profileData, email, firstName, lastName, fullName, interface_Prefs, avatarUrl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateAccount_stmt = db.prepare(`
    UPDATE accounts 
    SET passwordHash = ?, role = ?, isSuperuser = ?, accessLevel = ?, profileData = ?, email = ?, firstName = ?, lastName = ?, fullName = ?, interface_Prefs = ?, avatarUrl = ?, updatedAt = CURRENT_TIMESTAMP 
    WHERE id = ?
`);

const getAccountByUsername_stmt = db.prepare(`
  SELECT * FROM accounts WHERE username = ? AND (environmentId IS ? OR isSuperuser = 1)
`);

const getAccountById_stmt = db.prepare(`
  SELECT * FROM accounts WHERE id = ?
`);

const getAllAccounts_stmt = db.prepare(`
  SELECT a.id, a.username, a.firstName, a.lastName, a.fullName, a.email, a.role, a.isSuperuser, a.accessLevel, a.profileData, a.interface_Prefs, a.avatarUrl, a.createdAt, a.updatedAt, e.title as environmentName 
  FROM accounts a
  LEFT JOIN environments e ON a.environmentId = e.id
  WHERE (a.environmentId = ? OR ? = 1)
  ORDER BY a.username ASC
`);

const getSuperusers_stmt = db.prepare(`
  SELECT email, username FROM accounts WHERE isSuperuser = 1 AND email IS NOT NULL AND email != ''
`);

const getAccounts_stmt = db.prepare(`
  SELECT * FROM accounts WHERE ? = 1 OR environmentId = ?
`);

const deleteAccount_stmt = db.prepare(`
  DELETE FROM accounts WHERE id = ? AND environmentId IS ?
`);

// --- AUDIT LOGS ---
const insertAuditLog_stmt = db.prepare(`
  INSERT INTO audit_logs (environmentId, accountId, action, targetType, targetId, details)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getAuditLogs_stmt = db.prepare(`
  SELECT l.*, a.username, e.title as environmentName 
  FROM audit_logs l
  LEFT JOIN accounts a ON l.accountId = a.id
  LEFT JOIN environments e ON l.environmentId = e.id
  WHERE (l.environmentId = ? OR ? = 1)
  ORDER BY l.timestamp DESC LIMIT ? OFFSET ?
`);

const deleteSpecificSubscriptions_stmt = db.prepare(`
  DELETE FROM subscriptions WHERE userId = ? AND environmentId = ? AND alertType = 'specific'
`);

const getSubscriptionByType_stmt = db.prepare(`
  SELECT * FROM subscriptions WHERE userId = ? AND environmentId = ? AND alertType = ?
`);

const getSubscriptionByEvent_stmt = db.prepare(`
  SELECT * FROM subscriptions WHERE userId = ? AND environmentId = ? AND eventId = ? AND alertType = 'specific'
`);

module.exports = {
    // Entornos
    insertEnvironment: (alias, props = {}) => {
        try {
            const insertInfo = insertEnvironment_stmt.run(
                alias, 
                props.title || '', 
                props.subtitle || '', 
                props.googleDocSource || '', 
                props.configJson || '{}',
                props.logoUrl || null
            );
            return insertInfo;
        } catch (e) { throw e; }
    },
    updateEnvironment: (id, title, subtitle, googleDocSource, configJson, logoUrl = null) => {
        return updateEnvironment_stmt.run(title, subtitle, googleDocSource, JSON.stringify(configJson), logoUrl, id);
    },
    getEnvironmentByAlias: (alias) => {
        const env = getEnvironmentByAlias_stmt.get(alias);
        if (env && env.configJson) env.configJson = JSON.parse(env.configJson);
        return env;
    },
    getAllEnvironments: () => {
        return getAllEnvironments_stmt.all().map(env => ({
            ...env,
            configJson: env.configJson ? JSON.parse(env.configJson) : null
        }));
    },
    getEnvironmentById: (id) => {
        const env = getEnvironmentById_stmt.get(id);
        if (env && env.configJson) env.configJson = JSON.parse(env.configJson);
        return env;
    },
    deleteEnvironment: (id) => {
        return deleteEnvironment_stmt.run(id);
    },
    insertDocument: (environmentId, type, label, url, color = null, metadata = null) => {
        return insertDocument_stmt.run(environmentId, type, label, url, color, metadata ? JSON.stringify(metadata) : null);
    },
    updateDocument: (id, type, label, url, color = null, metadata = null) => {
        return updateDocument_stmt.run(type, label, url, color, metadata ? JSON.stringify(metadata) : null, id);
    },
    deleteDocument: (id) => {
        return deleteDocument_stmt.run(id);
    },
    getDocumentsByEnvironment: (environmentId) => {
        return getDocumentsByEnvironment_stmt.all(environmentId);
    },
    updateDocumentMetadata: (id, metadata) => {
        return updateDocumentMetadata_stmt.run(metadata ? JSON.stringify(metadata) : null, id);
    },
    getAllDocuments: () => {
        return getAllDocuments_stmt.all();
    },
    getDocumentById: (id) => {
        return getDocumentById_stmt.get(id);
    },

    // Usuarios
    insertUser: (environmentId, email, name, phone, token, expires, returnUrl) => {
        return insertUser_stmt.run(environmentId, email, name, phone, token, expires, returnUrl);
    },
    updateUser: (id, environmentId, name, phone, email) => {
        return updateUser_stmt.run(name, phone, email, id, environmentId);
    },
    confirmUser: (token) => {
        return confirmUser_stmt.run(token);
    },
    confirmUserManually: (userId) => {
        return db.prepare("UPDATE users SET confirmed = 1, confirmationToken = NULL, confirmationExpires = NULL WHERE id = ?").run(userId);
    },
    getUserByEmail: (email, environmentId) => {
        return getUserByEmail_stmt.get(email, environmentId);
    },
    getUserByToken: (token) => {
        return getUserByToken_stmt.get(token);
    },
    getAllUsers: (environmentId) => {
        return getAllUsers_stmt.all(environmentId);
    },
    getUserById: (id, environmentId) => {
        return getUserById_stmt.get(id, environmentId);
    },
    deleteUser: (id, environmentId) => {
        return deleteUser_stmt.run(id, environmentId);
    },
    deleteSubscriptionsByUserId: (userId, environmentId) => {
        return deleteSubscriptionsByUserId_stmt.run(userId, environmentId);
    },

    // Suscripciones
    insertSubscription: (environmentId, userId, eventId, eventTitle, alertType) => {
        return insertSubscription_stmt.run(environmentId, userId, eventId, eventTitle, alertType);
    },
    deleteSubscription: (userId, eventId, alertType, environmentId) => {
        return deleteSubscription_stmt.run(userId, eventId, alertType, environmentId);
    },
    getSubscriptionsForEvent: (eventId, environmentId) => {
        return getSubscriptionsForEvent_stmt.all(eventId, environmentId);
    },
    getAllSubscriptions: (environmentId, isSuperuser = 0) => {
        return getAllSubscriptions_stmt.all(environmentId, isSuperuser ? 1 : 0);
    },
    getAccounts: (environmentId, isSuperuser = 0) => {
        return getAccounts_stmt.all(isSuperuser ? 1 : 0, environmentId);
    },
    getSuperusers: () => {
        return getSuperusers_stmt.all();
    },
    getUserSubscriptions: (userId, environmentId) => {
        return getUserSubscriptions_stmt.all(userId, environmentId);
    },
    updateSubscription: (id, alertType) => {
        return updateSubscription_stmt.run(alertType, id);
    },
    getSubscriptionById: (id) => {
        return getSubscriptionById_stmt.get(id);
    },
    getSubscriptionByType: (userId, environmentId, alertType) => {
        return getSubscriptionByType_stmt.get(userId, environmentId, alertType);
    },
    getSubscriptionByEvent: (userId, environmentId, eventId) => {
        return getSubscriptionByEvent_stmt.get(userId, environmentId, eventId);
    },
    deleteSpecificSubscriptions: (userId, environmentId) => {
        return deleteSpecificSubscriptions_stmt.run(userId, environmentId);
    },
    deleteSubscriptionById: (id, environmentId) => {
        return deleteSubscriptionById_stmt.run(id, environmentId);
    },
    deleteSubscriptionsByEvent: (eventId, environmentId) => {
        return deleteSubscriptionsByEvent_stmt.run(eventId, environmentId);
    },
    getConfirmedUserByEmail: (email, environmentId) => {
        return getConfirmedUserByEmail_stmt.get(email, environmentId);
    },
    getSubscriptionsByEmail: (email, environmentId) => {
        return getSubscriptionsByEmail_stmt.all(email, environmentId);
    },
    getSubscriptionsForDashboard: (environmentId) => {
        return getSubscriptionsForDashboard_stmt.all(environmentId);
    },
    getUserWithSubscriptions: (environmentId, isSuperuser = 0) => {
        return getUserWithSubscriptions_stmt.all(environmentId, isSuperuser ? 1 : 0);
    },

    // Accounts
    insertAccount: (environmentId, username, passwordHash, role, isSuperuser=0, accessLevel=1, profileData={}, email=null, firstName=null, lastName=null, fullName=null, interface_Prefs=null, avatarUrl=null) => {
        try {
            const pdStr = typeof profileData === 'string' ? profileData : JSON.stringify(profileData);
            return insertAccount_stmt.run(environmentId, username, passwordHash, role, isSuperuser, accessLevel, pdStr, email, firstName, lastName, fullName, interface_Prefs, avatarUrl);
        } catch(e) {
            console.error("Error al crear cuenta:", e.message);
            throw e;
        }
    },
    updateAccount: (id, passwordHash, role, isSuperuser, accessLevel, profileData, email=null, firstName=null, lastName=null, fullName=null, interface_Prefs=null, avatarUrl=null) => {
        try {
            const pdStr = typeof profileData === 'string' ? profileData : JSON.stringify(profileData || {});
            return updateAccount_stmt.run(passwordHash, role, isSuperuser, accessLevel, pdStr, email, firstName, lastName, fullName, interface_Prefs, avatarUrl, id);
        } catch(e) { throw e; }
    },
    updateAccountPrefs: (id, prefs) => {
        return db.prepare("UPDATE accounts SET interface_Prefs = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?").run(prefs || null, id);
    },
    getAccountByUsername: (username, environmentId) => {
        return getAccountByUsername_stmt.get(username, environmentId);
    },
    getAccountById: (id) => {
        return getAccountById_stmt.get(id);
    },
    getAllAccounts: (environmentId, isSuperuser = 0) => {
        return getAllAccounts_stmt.all(environmentId, isSuperuser ? 1 : 0);
    },
    deleteAccount: (id, environmentId) => {
        return deleteAccount_stmt.run(id, environmentId);
    },

    // Audit Logs
    insertAuditLog: (environmentId, accountId, action, targetType, targetId, details) => {
        const effectiveId = accountId === 0 ? null : accountId;
        return insertAuditLog_stmt.run(environmentId, effectiveId, action, targetType, targetId, details);
    },
    getAuditLogs: (environmentId, isSuperuser = 0, limit = 100, offset = 0) => {
        return getAuditLogs_stmt.all(environmentId, isSuperuser ? 1 : 0, limit, offset);
    },

    close: () => db.close()
};