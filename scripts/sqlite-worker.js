/**
 * SQLite WASM Worker with OPFS Backend
 * Uses @aspect-build/aspect-cli sqlite3 WASM build
 * Persists data to Origin Private File System
 */

let db = null;
let SQL = null;

// Initialize SQLite with OPFS
async function initDB() {
    try {
        // Load sql.js which has better CDN/CORS support
        // and can work with OPFS via a custom VFS
        importScripts('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js');

        SQL = await initSqlJs({
            locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
        });

        // Check if OPFS is available
        let opfsAvailable = false;
        let existingData = null;

        if ('storage' in navigator && 'getDirectory' in navigator.storage) {
            try {
                const opfsRoot = await navigator.storage.getDirectory();
                const dbDir = await opfsRoot.getDirectoryHandle('sqlite-databases', { create: true });

                // Try to load existing database
                try {
                    const fileHandle = await dbDir.getFileHandle('guestbook.sqlite3');
                    const file = await fileHandle.getFile();
                    const buffer = await file.arrayBuffer();
                    existingData = new Uint8Array(buffer);
                    console.log('Loaded existing database from OPFS');
                } catch (e) {
                    // File doesn't exist yet
                    console.log('No existing database in OPFS');
                }

                opfsAvailable = true;
            } catch (e) {
                console.log('OPFS not available:', e);
            }
        }

        // Create database (from existing data or new)
        if (existingData) {
            db = new SQL.Database(existingData);
        } else {
            db = new SQL.Database();
        }

        // Create tables
        db.run(`
            CREATE TABLE IF NOT EXISTS guestbook_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                location TEXT,
                message TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS access_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT,
                timestamp TEXT DEFAULT (datetime('now')),
                user_agent TEXT
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS guestbook_metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Save to OPFS if available
        if (opfsAvailable) {
            await saveToOPFS();
        }

        console.log('SQLite database initialized, OPFS:', opfsAvailable);
        return { success: true, opfs: opfsAvailable };

    } catch (error) {
        console.error('SQLite init error:', error);
        return { success: false, error: error.message };
    }
}

// Save database to OPFS
async function saveToOPFS() {
    if (!db) return;

    try {
        const opfsRoot = await navigator.storage.getDirectory();
        const dbDir = await opfsRoot.getDirectoryHandle('sqlite-databases', { create: true });
        const fileHandle = await dbDir.getFileHandle('guestbook.sqlite3', { create: true });

        // Get database as binary
        const data = db.export();
        const uint8Array = new Uint8Array(data);

        // Write to OPFS
        const writable = await fileHandle.createWritable();
        await writable.write(uint8Array);
        await writable.close();

        console.log('Database saved to OPFS');
    } catch (error) {
        console.error('Error saving to OPFS:', error);
    }
}

// Execute a query and return results
function executeQuery(sql, params = []) {
    if (!db) throw new Error('Database not initialized');

    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);

    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// Execute a statement (INSERT, UPDATE, DELETE)
function executeStatement(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    db.run(sql, params);
    return {
        changes: db.getRowsModified(),
        lastInsertRowid: null // sql.js doesn't expose this easily
    };
}

// Handle messages from main thread
self.onmessage = async function(event) {
    const { id, action, data } = event.data;

    try {
        let result;

        switch (action) {
            case 'init':
                result = await initDB();
                break;

            case 'addEntry':
                executeStatement(
                    'INSERT INTO guestbook_entries (name, location, message) VALUES (?, ?, ?)',
                    [data.name, data.location || null, data.message]
                );
                executeStatement(
                    'INSERT INTO access_log (action, user_agent) VALUES (?, ?)',
                    ['guestbook_sign', data.userAgent || 'unknown']
                );
                await saveToOPFS();
                result = { success: true };
                break;

            case 'getEntries':
                result = executeQuery(
                    'SELECT * FROM guestbook_entries ORDER BY created_at DESC LIMIT ?',
                    [data.limit || 10]
                );
                break;

            case 'getCount':
                const countResult = executeQuery('SELECT COUNT(*) as count FROM guestbook_entries');
                result = countResult[0]?.count || 0;
                break;

            case 'logPageView':
                executeStatement(
                    'INSERT INTO access_log (action, user_agent) VALUES (?, ?)',
                    ['page_view', data.userAgent || 'unknown']
                );
                await saveToOPFS();
                result = { success: true };
                break;

            case 'getAccessLog':
                result = executeQuery(
                    'SELECT * FROM access_log ORDER BY timestamp DESC LIMIT ?',
                    [data.limit || 50]
                );
                break;

            case 'execSQL':
                if (data.sql.trim().toUpperCase().startsWith('SELECT')) {
                    result = executeQuery(data.sql, data.params || []);
                } else {
                    result = executeStatement(data.sql, data.params || []);
                    await saveToOPFS();
                }
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        self.postMessage({ id, success: true, result });

    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({ id, success: false, error: error.message });
    }
};

console.log('SQLite OPFS Worker loaded');
