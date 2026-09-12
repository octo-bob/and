/*
 * Equipment file destinations for the inventory page.
 *
 * A file leaving this page can go to one of three places, depending on what
 * the browser offers:
 *
 *   showSaveFilePicker   the user names a real path and the page writes to it
 *   showDirectoryPicker  the user names a real folder and the page writes into it
 *   <a download>         the browser's own download flow performs the write
 *
 * A directory the user has chosen is kept in IndexedDB so later exports can
 * reuse it without asking again. A FileSystemHandle is structured cloneable,
 * so the handle itself is stored rather than a path string, and access to it
 * has to be rechecked on every visit because the grant lives in the browser
 * profile and not in this database.
 */
(function () {
    'use strict';

    const DB_NAME = 'inventoryFileHandles';
    const DB_VERSION = 1;
    const STORE = 'handles';

    const EXPORT_DIR_KEY = 'exportDirectory';
    const LAST_FILE_KEY = 'lastSavedFile';

    // Chrome remembers the directory a picker last used, keyed by this id
    // together with the origin. Separate ids keep the manifest export and the
    // photo archive pointed at separate folders instead of fighting over one.
    // An id remembered by the browser takes precedence over startIn, so the
    // page's stored handle only decides where the very first pick opens.
    const SAVE_PICKER_ID = 'inventory-exports';
    const DIR_PICKER_ID = 'inventory-photo-archive';

    const SAVE_LOG_KEY = 'inventoryFileSaves';
    const MAX_SAVES = 200;

    const support = {
        savePicker: typeof window.showSaveFilePicker === 'function',
        directoryPicker: typeof window.showDirectoryPicker === 'function',
        opfs: !!(navigator.storage && navigator.storage.getDirectory),
        legacyFileSystem: typeof window.webkitRequestFileSystem === 'function',
        estimate: !!(navigator.storage && navigator.storage.estimate)
    };

    /* ------------------------------------------------------------------ *
     * Handle storage
     * ------------------------------------------------------------------ */

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
        return dbPromise;
    }

    async function idbGet(key) {
        const db = await openDb();
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbPut(key, value) {
        const db = await openDb();
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { reject(tx.error); };
        });
    }

    async function idbDelete(key) {
        const db = await openDb();
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { reject(tx.error); };
        });
    }

    // Stored alongside the handle so the record is readable on its own, without
    // having to resolve the handle to find out what it was.
    function handleRecord(handle, pickerId) {
        return {
            handle: handle,
            name: handle.name,
            kind: handle.kind,
            pickerId: pickerId,
            pickedAt: new Date().toISOString()
        };
    }

    async function storedDirectory() {
        try {
            const record = await idbGet(EXPORT_DIR_KEY);
            return record && record.handle ? record : null;
        } catch (error) {
            console.warn('Could not read the stored export folder:', error);
            return null;
        }
    }

    /* ------------------------------------------------------------------ *
     * Permission
     * ------------------------------------------------------------------ */

    // 'granted', 'prompt', 'denied', or 'unsupported' on a browser without the
    // permission methods. The answer can differ from what this page last saw,
    // because the user can revoke the grant in browser settings at any time.
    async function permissionState(handle, mode) {
        if (!handle || typeof handle.queryPermission !== 'function') {
            return 'unsupported';
        }
        try {
            return await handle.queryPermission({ mode: mode || 'readwrite' });
        } catch (error) {
            console.warn('Permission query failed:', error);
            return 'unsupported';
        }
    }

    // requestPermission needs transient user activation, so this has to be
    // reached from a click and cannot run on load.
    async function requestAccess() {
        const record = await storedDirectory();
        if (!record) return 'no-directory';

        const current = await permissionState(record.handle, 'readwrite');
        if (current === 'granted') {
            await render();
            return 'granted';
        }
        if (typeof record.handle.requestPermission !== 'function') {
            return 'unsupported';
        }

        let state;
        try {
            state = await record.handle.requestPermission({ mode: 'readwrite' });
        } catch (error) {
            console.warn('Permission request failed:', error);
            return 'error';
        }
        recordSave({
            name: record.name,
            method: 'permission-' + state,
            bytes: null,
            directory: record.name
        });
        await render();
        return state;
    }

    /* ------------------------------------------------------------------ *
     * Save record
     * ------------------------------------------------------------------ */

    function readSaves() {
        try {
            const raw = localStorage.getItem(SAVE_LOG_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('Save record unreadable, starting a new one:', error);
            return [];
        }
    }

    function recordSave(entry) {
        const saves = readSaves();
        saves.unshift({
            at: new Date().toISOString(),
            name: entry.name || '(unnamed)',
            method: entry.method,
            bytes: typeof entry.bytes === 'number' ? entry.bytes : null,
            directory: entry.directory || null
        });
        if (saves.length > MAX_SAVES) saves.length = MAX_SAVES;
        try {
            localStorage.setItem(SAVE_LOG_KEY, JSON.stringify(saves));
        } catch (error) {
            console.warn('Could not write the save record:', error);
        }
        return saves[0];
    }

    function clearSaves() {
        try {
            localStorage.removeItem(SAVE_LOG_KEY);
        } catch (error) {
            console.warn('Could not clear the save record:', error);
        }
        renderSaves();
    }

    /* ------------------------------------------------------------------ *
     * Saving
     * ------------------------------------------------------------------ */

    // The download attribute route. Used when the picker is missing, and the
    // only route any browser without the File System Access API can take.
    function saveByDownload(blob, suggestedName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        const saved = recordSave({
            name: suggestedName,
            method: 'anchor-download',
            bytes: blob.size
        });
        renderSaves();
        return { method: 'anchor-download', name: suggestedName, entry: saved };
    }

    // Writes blob to wherever the user points the picker. Falls back to the
    // download attribute when the picker is unavailable. Resolves with
    // method 'cancelled' if the user dismisses the dialog.
    async function saveBlob(blob, suggestedName, types) {
        if (!support.savePicker) {
            return saveByDownload(blob, suggestedName);
        }

        const options = { suggestedName: suggestedName, id: SAVE_PICKER_ID };
        if (types) options.types = types;

        // Only consulted the first time this picker id is used on the origin.
        const remembered = await storedDirectory();
        if (remembered) {
            options.startIn = remembered.handle;
        }

        let handle;
        try {
            handle = await window.showSaveFilePicker(options);
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return { method: 'cancelled', name: suggestedName };
            }
            throw error;
        }

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        try {
            await idbPut(LAST_FILE_KEY, handleRecord(handle, SAVE_PICKER_ID));
        } catch (error) {
            console.warn('Could not store the saved file handle:', error);
        }

        const saved = recordSave({
            name: handle.name,
            method: 'file-system-access',
            bytes: blob.size
        });
        renderSaves();
        await render();
        return { method: 'file-system-access', name: handle.name, entry: saved };
    }

    /* ------------------------------------------------------------------ *
     * Directory
     * ------------------------------------------------------------------ */

    async function pickExportDirectory() {
        if (!support.directoryPicker) return { ok: false, reason: 'unsupported' };

        const options = { mode: 'readwrite', id: DIR_PICKER_ID };
        const remembered = await storedDirectory();
        if (remembered) options.startIn = remembered.handle;

        let handle;
        try {
            handle = await window.showDirectoryPicker(options);
        } catch (error) {
            if (error && error.name === 'AbortError') {
                return { ok: false, reason: 'cancelled' };
            }
            throw error;
        }

        await idbPut(EXPORT_DIR_KEY, handleRecord(handle, DIR_PICKER_ID));
        recordSave({
            name: handle.name,
            method: 'directory-selected',
            bytes: null,
            directory: handle.name
        });
        renderSaves();
        await render();
        return { ok: true, name: handle.name };
    }

    // Drops this page's pointer to the folder. The browser's own permission
    // grant for that folder is a separate record and is not affected.
    async function forgetDirectory() {
        await idbDelete(EXPORT_DIR_KEY);
        recordSave({ name: '(export folder)', method: 'directory-forgotten', bytes: null });
        renderSaves();
        await render();
        return true;
    }

    // entries: [{ blob, name, folder }]. Each folder becomes a subdirectory of
    // the chosen folder, which mirrors how the page sorts uploads by extension
    // inside the legacy sandboxed filesystem.
    async function writeFiles(entries) {
        const record = await storedDirectory();
        if (!record) return { ok: false, reason: 'no-directory' };

        let state = await permissionState(record.handle, 'readwrite');
        if (state === 'prompt' && typeof record.handle.requestPermission === 'function') {
            try {
                state = await record.handle.requestPermission({ mode: 'readwrite' });
            } catch (error) {
                console.warn('Permission request failed during write:', error);
            }
        }
        if (state !== 'granted') {
            await render();
            return { ok: false, reason: 'permission-' + state, directory: record.name };
        }

        const written = [];
        const failed = [];

        for (const entry of entries) {
            try {
                let target = record.handle;
                if (entry.folder) {
                    target = await target.getDirectoryHandle(entry.folder, { create: true });
                }
                const fileHandle = await target.getFileHandle(entry.name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(entry.blob);
                await writable.close();

                written.push(entry.name);
                recordSave({
                    name: (entry.folder ? entry.folder + '/' : '') + entry.name,
                    method: 'directory-write',
                    bytes: entry.blob.size,
                    directory: record.name
                });
            } catch (error) {
                console.error('Failed to write ' + entry.name + ':', error);
                failed.push({ name: entry.name, message: error && error.message });
            }
        }

        renderSaves();
        await render();
        return { ok: failed.length === 0, written: written, failed: failed, directory: record.name };
    }

    /* ------------------------------------------------------------------ *
     * Display
     * ------------------------------------------------------------------ */

    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || isNaN(bytes)) return 'n/a';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function formatTime(iso) {
        const when = new Date(iso);
        return isNaN(when.getTime()) ? iso : when.toLocaleString();
    }

    function row(label, value, className) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = label;
        const td = document.createElement('td');
        td.textContent = value;
        if (className) td.className = className;
        tr.appendChild(th);
        tr.appendChild(td);
        return tr;
    }

    const PERMISSION_LABEL = {
        granted: 'Granted',
        prompt: 'Needs confirmation',
        denied: 'Denied',
        unsupported: 'Not reported by this browser'
    };

    async function render() {
        const target = document.getElementById('fsDestination');
        if (!target) return;

        const table = document.createElement('table');
        table.className = 'fs-table';

        table.appendChild(row('Save method',
            support.savePicker ? 'File System Access (user picks the path)'
                               : 'Browser download (the browser picks the path)'));

        const record = await storedDirectory();
        if (record) {
            const state = await permissionState(record.handle, 'readwrite');
            table.appendChild(row('Export folder', record.name, 'fs-folder'));
            table.appendChild(row('Folder chosen', formatTime(record.pickedAt)));
            table.appendChild(row('Write access',
                PERMISSION_LABEL[state] || state,
                state === 'granted' ? 'fs-ok' : 'fs-attention'));
        } else {
            table.appendChild(row('Export folder',
                support.directoryPicker ? 'Not set' : 'Not available in this browser'));
        }

        if (support.estimate) {
            try {
                const estimate = await navigator.storage.estimate();
                table.appendChild(row('Browser storage used',
                    formatBytes(estimate.usage) + ' of ' + formatBytes(estimate.quota)));
            } catch (error) {
                console.warn('Storage estimate unavailable:', error);
            }
        }

        target.textContent = '';
        target.appendChild(table);

        const restore = document.getElementById('fsRestoreAccess');
        if (restore) {
            restore.disabled = !record;
        }
        const forget = document.getElementById('fsForgetFolder');
        if (forget) {
            forget.disabled = !record;
        }
        const choose = document.getElementById('fsChooseFolder');
        if (choose) {
            choose.disabled = !support.directoryPicker;
        }
    }

    function renderSaves() {
        const target = document.getElementById('fsSaveLog');
        if (!target) return;

        const saves = readSaves();
        target.textContent = '';

        const count = document.getElementById('fsSaveCount');
        if (count) {
            count.textContent = saves.length === 0
                ? 'Nothing saved from this page yet.'
                : saves.length === 1 ? '1 entry recorded.' : saves.length + ' entries recorded.';
        }

        if (saves.length === 0) return;

        const table = document.createElement('table');
        table.className = 'fs-table fs-log-table';

        const head = document.createElement('tr');
        ['When', 'File', 'Route', 'Size'].forEach(function (label) {
            const th = document.createElement('th');
            th.textContent = label;
            head.appendChild(th);
        });
        table.appendChild(head);

        saves.forEach(function (entry) {
            const tr = document.createElement('tr');

            const when = document.createElement('td');
            when.textContent = formatTime(entry.at);
            tr.appendChild(when);

            const name = document.createElement('td');
            name.textContent = entry.name;
            tr.appendChild(name);

            const method = document.createElement('td');
            method.textContent = entry.method;
            method.className = 'fs-method';
            tr.appendChild(method);

            const size = document.createElement('td');
            size.textContent = entry.bytes === null ? '' : formatBytes(entry.bytes);
            tr.appendChild(size);

            table.appendChild(tr);
        });

        target.appendChild(table);
    }

    /* ------------------------------------------------------------------ *
     * Wiring
     * ------------------------------------------------------------------ */

    function status(message, type) {
        if (typeof window.showStatus === 'function') {
            window.showStatus(message, type || 'info');
        } else {
            console.log(message);
        }
    }

    function wireButtons() {
        const choose = document.getElementById('fsChooseFolder');
        if (choose) {
            choose.addEventListener('click', function () {
                pickExportDirectory().then(function (result) {
                    if (result.ok) {
                        status('Export folder set to "' + result.name + '".', 'success');
                    } else if (result.reason === 'cancelled') {
                        status('Folder selection cancelled.', 'info');
                    } else {
                        status('This browser cannot choose a folder. Exports will use the download flow.', 'warning');
                    }
                }).catch(function (error) {
                    status('Could not set the export folder: ' + error.message, 'error');
                });
            });
        }

        const restore = document.getElementById('fsRestoreAccess');
        if (restore) {
            restore.addEventListener('click', function () {
                requestAccess().then(function (state) {
                    if (state === 'granted') {
                        status('Write access to the export folder confirmed.', 'success');
                    } else if (state === 'no-directory') {
                        status('Choose an export folder first.', 'warning');
                    } else {
                        status('Write access was not granted (' + state + ').', 'warning');
                    }
                }).catch(function (error) {
                    status('Could not confirm folder access: ' + error.message, 'error');
                });
            });
        }

        const forget = document.getElementById('fsForgetFolder');
        if (forget) {
            forget.addEventListener('click', function () {
                forgetDirectory().then(function () {
                    status('Export folder cleared from this page.', 'success');
                }).catch(function (error) {
                    status('Could not clear the export folder: ' + error.message, 'error');
                });
            });
        }

        const clear = document.getElementById('fsClearLog');
        if (clear) {
            clear.addEventListener('click', function () {
                clearSaves();
                render();
                status('Save record cleared.', 'success');
            });
        }
    }

    // Held back until the access check passes, so a locked page does not read
    // the handle store or report on folders behind the login notice.
    let started = false;
    function start() {
        if (started) return Promise.resolve();
        started = true;
        renderSaves();
        return render().catch(function (error) {
            console.warn('Could not render file destinations:', error);
        });
    }

    function init() {
        wireButtons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.fileSave = {
        start: start,
        support: support,
        saveBlob: saveBlob,
        saveByDownload: saveByDownload,
        pickExportDirectory: pickExportDirectory,
        forgetDirectory: forgetDirectory,
        writeFiles: writeFiles,
        requestAccess: requestAccess,
        permissionState: permissionState,
        storedDirectory: storedDirectory,
        readSaves: readSaves,
        recordSave: recordSave,
        clearSaves: clearSaves,
        render: render,
        renderSaves: renderSaves,
        formatBytes: formatBytes
    };
})();
