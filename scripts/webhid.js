/**
 * WebHID device registry for the Tank Management page.
 *
 * Builds and persists a record of every HID device this origin has been
 * able to see, so the traces are recoverable after the fact.
 *
 * Three separate stores are written on purpose, because each one behaves
 * differently under examination:
 *
 *   localStorage   hidDeviceRegistry  durable, one entry per distinct device
 *   localStorage   hidDeviceEvents    durable, capped timeline of sightings
 *   sessionStorage connectedDevices   per tab, cleared when the tab closes
 *
 * Scope limit worth understanding: WebHID cannot enumerate the USB bus.
 * A page only ever learns about devices the user has already granted it,
 * plus devices the user picks in the chooser. The chooser itself sees every
 * attached HID device, but that list is never exposed to script.
 */
(function () {
    'use strict';

    var REGISTRY_KEY = 'hidDeviceRegistry';
    var EVENTS_KEY = 'hidDeviceEvents';
    var SESSION_KEY = 'connectedDevices';

    // Both logs are capped so a long-lived profile cannot grow them without bound.
    var MAX_EVENTS = 250;
    var MAX_DEVICES = 60;

    // Small lookup tables. Anything not listed is reported as unknown rather
    // than guessed at, so the record never invents a vendor.
    var VENDORS = {
        0x03eb: 'Atmel',
        0x0403: 'FTDI',
        0x045e: 'Microsoft',
        0x046d: 'Logitech',
        0x04d8: 'Microchip',
        0x05ac: 'Apple',
        0x0781: 'SanDisk',
        0x1a86: 'QinHeng (CH34x)',
        0x1b4f: 'SparkFun',
        0x2341: 'Arduino',
        0x239a: 'Adafruit',
        0x2e8a: 'Raspberry Pi',
        0x303a: 'Espressif',
        0x16c0: 'Van Ooijen / Teensy'
    };

    var USAGE_PAGES = {
        0x01: 'Generic Desktop',
        0x02: 'Simulation Controls',
        0x03: 'VR Controls',
        0x04: 'Sport Controls',
        0x05: 'Game Controls',
        0x06: 'Generic Device Controls',
        0x07: 'Keyboard/Keypad',
        0x08: 'LEDs',
        0x09: 'Button',
        0x0a: 'Ordinal',
        0x0b: 'Telephony',
        0x0c: 'Consumer',
        0x0d: 'Digitizer',
        0x0f: 'Physical Input Device',
        0x10: 'Unicode',
        0x14: 'Alphanumeric Display',
        0x20: 'Sensors',
        0x40: 'Medical Instrument',
        0x8c: 'Bar Code Scanner',
        0x8d: 'Scale',
        0x90: 'Camera Control',
        0x91: 'Arcade'
    };

    // Usages that matter on the Generic Desktop page, for readability.
    var GENERIC_DESKTOP_USAGES = {
        0x01: 'Pointer',
        0x02: 'Mouse',
        0x04: 'Joystick',
        0x05: 'Game Pad',
        0x06: 'Keyboard',
        0x07: 'Keypad',
        0x08: 'Multi-axis Controller',
        0x80: 'System Control'
    };

    function hex(n) {
        if (typeof n !== 'number' || isNaN(n)) return 'n/a';
        return '0x' + (n + 0x10000).toString(16).substr(-4).toUpperCase();
    }

    function vendorName(vid) {
        return VENDORS[vid] || 'unknown vendor';
    }

    function usagePageName(page) {
        if (page >= 0xff00) return 'Vendor-defined';
        return USAGE_PAGES[page] || 'unknown page';
    }

    function usageName(page, usage) {
        if (page === 0x01) return GENERIC_DESKTOP_USAGES[usage] || 'unknown usage';
        if (page >= 0xff00) return 'Vendor-defined';
        return 'see usage page';
    }

    // A device has no serial number over WebHID, so identity is vendor,
    // product and name. Two identical models are indistinguishable here,
    // which is itself worth knowing when reading the record.
    function deviceKey(device) {
        return hex(device.vendorId) + ':' + hex(device.productId) + ':' +
               (device.productName || '(no product name)');
    }

    function summarizeReports(reports) {
        var list = reports || [];
        return list.map(function (report) {
            var bits = (report.items || []).reduce(function (sum, item) {
                return sum + ((item.reportSize || 0) * (item.reportCount || 0));
            }, 0);
            return {
                reportId: report.reportId,
                itemCount: (report.items || []).length,
                totalBits: bits,
                totalBytes: Math.ceil(bits / 8)
            };
        });
    }

    // Flatten the report descriptor tree into something JSON can hold and a
    // student can read. HIDCollectionInfo objects do not survive JSON.stringify
    // usefully on their own.
    function snapshotCollections(collections) {
        return (collections || []).map(function (c) {
            return {
                usagePage: c.usagePage,
                usagePageHex: hex(c.usagePage),
                usagePageName: usagePageName(c.usagePage),
                usage: c.usage,
                usageHex: hex(c.usage),
                usageName: usageName(c.usagePage, c.usage),
                inputReports: summarizeReports(c.inputReports),
                outputReports: summarizeReports(c.outputReports),
                featureReports: summarizeReports(c.featureReports),
                children: snapshotCollections(c.children)
            };
        });
    }

    function countReports(snapshot) {
        return snapshot.reduce(function (acc, c) {
            var child = countReports(c.children);
            return {
                input: acc.input + c.inputReports.length + child.input,
                output: acc.output + c.outputReports.length + child.output,
                feature: acc.feature + c.featureReports.length + child.feature
            };
        }, { input: 0, output: 0, feature: 0 });
    }

    // Storage can throw (private browsing, blocked site data, quota), and a
    // logging feature must never take the page down with it.
    function readJSON(store, key, fallback) {
        try {
            var raw = store.getItem(key);
            if (!raw) return fallback;
            var parsed = JSON.parse(raw);
            return parsed === null ? fallback : parsed;
        } catch (e) {
            return fallback;
        }
    }

    function writeJSON(store, key, value) {
        try {
            store.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    function nowISO() {
        return new Date().toISOString();
    }

    function recordEvent(type, key, note) {
        var events = readJSON(localStorage, EVENTS_KEY, []);
        if (!Array.isArray(events)) events = [];
        events.push({ at: nowISO(), type: type, device: key || null, note: note || null });
        // Keep the newest MAX_EVENTS entries.
        if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
        writeJSON(localStorage, EVENTS_KEY, events);
        return events;
    }

    /**
     * Upsert a device into the durable registry.
     *
     * `method` records how the page learned about the device, which is the
     * most important field in the whole record:
     *
     *   granted-earlier  returned by getDevices() with no user gesture, so a
     *                    permission grant already existed in this profile
     *   user-selected    the user picked it in the chooser during this visit
     *   connect-event    plugged in while the page was open
     */
    function recordDevice(device, method) {
        var registry = readJSON(localStorage, REGISTRY_KEY, {});
        if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) registry = {};

        var key = deviceKey(device);
        var snapshot = snapshotCollections(device.collections);
        var entry = registry[key];

        if (!entry) {
            // Evict the least recently seen device once the cap is hit.
            var keys = Object.keys(registry);
            if (keys.length >= MAX_DEVICES) {
                keys.sort(function (a, b) {
                    return String(registry[a].lastSeen).localeCompare(String(registry[b].lastSeen));
                });
                delete registry[keys[0]];
            }
            entry = {
                key: key,
                productName: device.productName || '(no product name)',
                vendorId: device.vendorId,
                vendorIdHex: hex(device.vendorId),
                vendorName: vendorName(device.vendorId),
                productId: device.productId,
                productIdHex: hex(device.productId),
                firstSeen: nowISO(),
                lastSeen: nowISO(),
                timesSeen: 0,
                discoveryMethods: [],
                collections: snapshot,
                reportCounts: countReports(snapshot)
            };
        }

        entry.lastSeen = nowISO();
        entry.timesSeen += 1;
        if (entry.discoveryMethods.indexOf(method) === -1) {
            entry.discoveryMethods.push(method);
        }
        // Refresh the descriptor in case a later sighting carries more detail.
        entry.collections = snapshot;
        entry.reportCounts = countReports(snapshot);

        registry[key] = entry;
        writeJSON(localStorage, REGISTRY_KEY, registry);
        recordEvent(method, key);
        recordSessionSighting(entry, method);
        return entry;
    }

    // Per-tab sighting list. The key name is kept from the original script so
    // anything already looking for it keeps working.
    function recordSessionSighting(entry, method) {
        var arr = readJSON(sessionStorage, SESSION_KEY, []);
        if (!Array.isArray(arr)) arr = [];
        arr.push({
            productName: entry.productName,
            vendorId: entry.vendorId,
            productId: entry.productId,
            vendorName: entry.vendorName,
            method: method,
            at: nowISO()
        });
        if (arr.length > MAX_EVENTS) arr = arr.slice(arr.length - MAX_EVENTS);
        writeJSON(sessionStorage, SESSION_KEY, arr);
    }

    // ---------------------------------------------------------------- rendering

    function el(id) {
        return document.getElementById(id);
    }

    function text(tag, value, className) {
        var node = document.createElement(tag);
        node.textContent = value;
        if (className) node.className = className;
        return node;
    }

    function writeLog(message) {
        var pane = el('log');
        if (!pane) return;
        var line = text('div', '[' + new Date().toLocaleTimeString() + '] ' + message);
        pane.appendChild(line);
        pane.scrollTop = pane.scrollHeight;
    }

    function describeCollections(snapshot, depth, lines) {
        var pad = new Array(depth + 1).join('  ');
        snapshot.forEach(function (c) {
            lines.push(pad + c.usagePageName + ' (' + c.usagePageHex + ') / ' +
                       c.usageName + ' (' + c.usageHex + ')');
            ['inputReports', 'outputReports', 'featureReports'].forEach(function (kind) {
                c[kind].forEach(function (r) {
                    lines.push(pad + '  ' + kind.replace('Reports', '') +
                               ' report id ' + r.reportId +
                               ', ' + r.itemCount + ' item(s), ' + r.totalBytes + ' byte(s)');
                });
            });
            describeCollections(c.children, depth + 1, lines);
        });
        return lines;
    }

    function renderRegistry() {
        var host = el('hidRegistry');
        if (!host) return;
        host.textContent = '';

        var registry = readJSON(localStorage, REGISTRY_KEY, {});
        var keys = Object.keys(registry);

        var count = el('hidDeviceCount');
        if (count) {
            count.textContent = keys.length === 0
                ? 'No devices recorded yet.'
                : keys.length + (keys.length === 1 ? ' device' : ' devices') + ' recorded.';
        }

        if (keys.length === 0) {
            host.appendChild(text('p', 'Nothing recorded for this origin yet. Use the button above to grant a device.', 'info-text'));
            return;
        }

        keys.sort(function (a, b) {
            return String(registry[b].lastSeen).localeCompare(String(registry[a].lastSeen));
        });

        keys.forEach(function (key) {
            var d = registry[key];
            var card = document.createElement('div');
            card.className = 'hid-device-card';

            card.appendChild(text('h4', d.productName));

            var table = document.createElement('table');
            table.className = 'hid-table';
            [
                ['Vendor', d.vendorIdHex + '  (' + d.vendorName + ')'],
                ['Product', d.productIdHex],
                ['First seen', d.firstSeen],
                ['Last seen', d.lastSeen],
                ['Times seen', String(d.timesSeen)],
                ['How it was seen', d.discoveryMethods.join(', ')],
                ['Reports', d.reportCounts.input + ' input, ' +
                            d.reportCounts.output + ' output, ' +
                            d.reportCounts.feature + ' feature']
            ].forEach(function (row) {
                var tr = document.createElement('tr');
                tr.appendChild(text('th', row[0]));
                tr.appendChild(text('td', row[1]));
                table.appendChild(tr);
            });
            card.appendChild(table);

            var lines = describeCollections(d.collections, 0, []);
            if (lines.length) {
                var details = document.createElement('details');
                details.appendChild(text('summary', 'Report descriptor (' + lines.length + ' lines)'));
                details.appendChild(text('pre', lines.join('\n'), 'hid-descriptor'));
                card.appendChild(details);
            }

            host.appendChild(card);
        });
    }

    function renderTimeline() {
        var host = el('hidTimeline');
        if (!host) return;
        host.textContent = '';

        var events = readJSON(localStorage, EVENTS_KEY, []);
        if (!Array.isArray(events) || events.length === 0) {
            host.appendChild(text('p', 'No events recorded yet.', 'info-text'));
            return;
        }

        var list = document.createElement('ol');
        list.className = 'hid-timeline-list';
        events.slice().reverse().forEach(function (ev) {
            var li = document.createElement('li');
            li.appendChild(text('span', ev.at, 'hid-event-time'));
            li.appendChild(text('span', ev.type, 'hid-event-type'));
            li.appendChild(text('span', ev.device || '', 'hid-event-device'));
            if (ev.note) li.appendChild(text('span', ev.note, 'hid-event-note'));
            list.appendChild(li);
        });
        host.appendChild(list);
    }

    function render() {
        renderRegistry();
        renderTimeline();
    }

    // ------------------------------------------------------------------ exports

    function buildReport() {
        return {
            generatedAt: nowISO(),
            origin: location.origin,
            page: location.pathname,
            userAgent: navigator.userAgent,
            webHidSupported: 'hid' in navigator,
            note: 'WebHID cannot enumerate the USB bus. This record holds only ' +
                  'devices granted to this origin or picked in the chooser.',
            devices: readJSON(localStorage, REGISTRY_KEY, {}),
            events: readJSON(localStorage, EVENTS_KEY, []),
            sessionSightings: readJSON(sessionStorage, SESSION_KEY, [])
        };
    }

    function csvCell(value) {
        var s = value === null || value === undefined ? '' : String(value);
        return '"' + s.replace(/"/g, '""') + '"';
    }

    function buildCSV() {
        var registry = readJSON(localStorage, REGISTRY_KEY, {});
        var header = ['productName', 'vendorIdHex', 'vendorName', 'productIdHex',
                      'firstSeen', 'lastSeen', 'timesSeen', 'discoveryMethods',
                      'inputReports', 'outputReports', 'featureReports'];
        var rows = [header.map(csvCell).join(',')];
        Object.keys(registry).forEach(function (key) {
            var d = registry[key];
            rows.push([
                d.productName, d.vendorIdHex, d.vendorName, d.productIdHex,
                d.firstSeen, d.lastSeen, d.timesSeen,
                d.discoveryMethods.join(' '),
                d.reportCounts.input, d.reportCounts.output, d.reportCounts.feature
            ].map(csvCell).join(','));
        });
        return rows.join('\r\n');
    }

    // Downloading is its own artifact: it lands in the browser's download
    // history and on disk, outside the profile's storage directories.
    function download(filename, mime, body) {
        var blob = new Blob([body], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        writeLog('Exported ' + filename);
    }

    function stamp() {
        return new Date().toISOString().replace(/[:.]/g, '-');
    }

    function exportJSON() {
        download('hid-device-record-' + stamp() + '.json', 'application/json',
                 JSON.stringify(buildReport(), null, 2));
    }

    function exportCSV() {
        download('hid-device-record-' + stamp() + '.csv', 'text/csv', buildCSV());
    }

    function copyJSON() {
        var body = JSON.stringify(buildReport(), null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(body).then(function () {
                writeLog('Record copied to clipboard.');
            }, function () {
                writeLog('Clipboard write was refused.');
            });
        } else {
            writeLog('Clipboard API unavailable in this browser.');
        }
    }

    // Clearing the site's own log does not revoke the browser's permission
    // grant. getDevices() will still return the device on the next load, which
    // is the point: the site log and the browser's grant are separate records.
    function clearRecord() {
        try {
            localStorage.removeItem(REGISTRY_KEY);
            localStorage.removeItem(EVENTS_KEY);
            sessionStorage.removeItem(SESSION_KEY);
        } catch (e) {
            // Nothing useful to do if storage is blocked.
        }
        writeLog('Site record cleared. The browser permission grant was NOT revoked.');
        render();
    }

    // --------------------------------------------------------------------- init

    function showUnsupported(reason) {
        var banner = el('hidSupport');
        if (banner) {
            banner.className = 'hid-banner hid-banner-warn';
            banner.textContent = reason;
        }
        writeLog(reason);
    }

    function enumerateGranted() {
        return navigator.hid.getDevices().then(function (devices) {
            if (!devices.length) {
                writeLog('No previously granted HID devices. Use the connect button.');
                return;
            }
            writeLog('Found ' + devices.length + ' device(s) already granted to this origin ' +
                     'with no user action required.');
            devices.forEach(function (device) {
                recordDevice(device, 'granted-earlier');
                writeLog('Recorded ' + device.productName + ' (' + hex(device.vendorId) +
                         ':' + hex(device.productId) + ')');
            });
        }, function (err) {
            writeLog('getDevices() failed: ' + err.message);
        });
    }

    function requestDevice() {
        return navigator.hid.requestDevice({ filters: [] }).then(function (devices) {
            if (!devices.length) {
                writeLog('Chooser dismissed without selecting a device.');
                recordEvent('chooser-dismissed', null);
                render();
                return;
            }
            devices.forEach(function (device) {
                recordDevice(device, 'user-selected');
                writeLog('User granted ' + device.productName + ' (' + hex(device.vendorId) +
                         ':' + hex(device.productId) + ')');
            });
            render();
        }, function (err) {
            writeLog('requestDevice() failed: ' + err.message);
            recordEvent('chooser-error', null, err.message);
            render();
        });
    }

    function wireButtons() {
        var connect = el('requestDeviceButton');
        if (connect) connect.addEventListener('click', requestDevice);

        var map = {
            hidExportJSON: exportJSON,
            hidExportCSV: exportCSV,
            hidCopyJSON: copyJSON,
            hidClearRecord: clearRecord
        };
        Object.keys(map).forEach(function (id) {
            var node = el(id);
            if (node) node.addEventListener('click', map[id]);
        });
    }

    function init() {
        wireButtons();
        render();

        if (!('hid' in navigator)) {
            showUnsupported('WebHID is not available in this browser. It is supported in ' +
                            'Chromium browsers (Chrome, Edge) over HTTPS or localhost. ' +
                            'Any record shown below was captured earlier in this profile.');
            var connect = el('requestDeviceButton');
            if (connect) connect.disabled = true;
            return;
        }

        var banner = el('hidSupport');
        if (banner) {
            banner.className = 'hid-banner hid-banner-ok';
            banner.textContent = 'WebHID is available. Devices already granted to this origin ' +
                                 'are listed without any user action.';
        }

        // Plug and unplug events only fire for devices that already have
        // permission, so this builds a timeline of physical device activity.
        navigator.hid.addEventListener('connect', function (e) {
            recordDevice(e.device, 'connect-event');
            writeLog('Device connected: ' + e.device.productName);
            render();
        });
        navigator.hid.addEventListener('disconnect', function (e) {
            recordEvent('disconnect-event', deviceKey(e.device));
            writeLog('Device disconnected: ' + e.device.productName);
            render();
        });

        enumerateGranted().then(render);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Exposed for the page and for testing.
    window.hidRecord = {
        buildReport: buildReport,
        buildCSV: buildCSV,
        recordDevice: recordDevice,
        recordEvent: recordEvent,
        deviceKey: deviceKey,
        snapshotCollections: snapshotCollections,
        clearRecord: clearRecord,
        render: render
    };
})();
