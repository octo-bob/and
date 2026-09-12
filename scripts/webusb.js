/**
 * WebUSB device registry for the USB Device Survey page.
 *
 * Deliberately parallel to scripts/webhid.js so the two can be read side by
 * side. The interesting difference is how much more WebUSB exposes:
 *
 *   WebHID gives   vendorId, productId, productName, report descriptors
 *   WebUSB adds    manufacturerName, SERIAL NUMBER, device and USB versions,
 *                  class/subclass/protocol, and the full configuration,
 *                  interface and endpoint tree
 *
 * The serial number is the one that matters. It is a hardware identifier
 * burned into the device, so it correlates the same physical device across
 * profiles, browsers and machines in a way a vendor/product pair never can.
 *
 * Three stores are written on purpose, because each behaves differently
 * under examination:
 *
 *   localStorage   usbDeviceRegistry  durable, one entry per distinct device
 *   localStorage   usbDeviceEvents    durable, capped timeline of sightings
 *   sessionStorage usbSessionDevices  per tab, cleared when the tab closes
 *
 * Device enumeration does NOT start on its own. The host page must call
 * window.usbRecord.start() once its access check has passed.
 */
(function () {
    'use strict';

    var REGISTRY_KEY = 'usbDeviceRegistry';
    var EVENTS_KEY = 'usbDeviceEvents';
    var SESSION_KEY = 'usbSessionDevices';

    var MAX_EVENTS = 250;
    var MAX_DEVICES = 60;

    var VENDORS = {
        0x03eb: 'Atmel',
        0x0403: 'FTDI',
        0x045e: 'Microsoft',
        0x046d: 'Logitech',
        0x04d8: 'Microchip',
        0x05ac: 'Apple',
        0x0781: 'SanDisk',
        0x090c: 'Silicon Motion',
        0x0bda: 'Realtek',
        0x13fe: 'Kingston',
        0x1a86: 'QinHeng (CH34x)',
        0x1b4f: 'SparkFun',
        0x2341: 'Arduino',
        0x239a: 'Adafruit',
        0x2e8a: 'Raspberry Pi',
        0x303a: 'Espressif',
        0x16c0: 'Van Ooijen / Teensy',
        0x8087: 'Intel'
    };

    // USB base class codes. Worth decoding because the class alone tells you
    // what kind of device it is without any vendor knowledge.
    var CLASSES = {
        0x00: 'Per-interface',
        0x01: 'Audio',
        0x02: 'Communications (CDC)',
        0x03: 'Human Interface Device',
        0x05: 'Physical',
        0x06: 'Image (PTP/MTP)',
        0x07: 'Printer',
        0x08: 'Mass Storage',
        0x09: 'Hub',
        0x0a: 'CDC Data',
        0x0b: 'Smart Card',
        0x0d: 'Content Security',
        0x0e: 'Video',
        0x0f: 'Personal Healthcare',
        0x10: 'Audio/Video',
        0x11: 'Billboard',
        0x12: 'USB Type-C Bridge',
        0xdc: 'Diagnostic',
        0xe0: 'Wireless Controller',
        0xef: 'Miscellaneous',
        0xfe: 'Application Specific',
        0xff: 'Vendor Specific'
    };

    // Interface classes the browser refuses to hand over to a page. A device
    // using only these can still be enumerated, but never communicated with.
    var PROTECTED_CLASSES = [0x01, 0x03, 0x08, 0x0b, 0x0e];

    function hex(n) {
        if (typeof n !== 'number' || isNaN(n)) return 'n/a';
        return '0x' + (n + 0x10000).toString(16).substr(-4).toUpperCase();
    }

    function hex2(n) {
        if (typeof n !== 'number' || isNaN(n)) return 'n/a';
        return '0x' + (n + 0x100).toString(16).substr(-2).toUpperCase();
    }

    function vendorName(vid) {
        return VENDORS[vid] || 'unknown vendor';
    }

    function className(code) {
        return CLASSES[code] || 'unknown class';
    }

    function version(major, minor, sub) {
        if (typeof major !== 'number') return 'n/a';
        return major + '.' + (minor || 0) + '.' + (sub || 0);
    }

    // Unlike WebHID, identity can use the serial number when the device
    // reports one. That makes the key genuinely device-specific rather than
    // model-specific, which is the whole point of the comparison.
    function deviceKey(device) {
        var serial = device.serialNumber ? device.serialNumber : 'no-serial';
        return hex(device.vendorId) + ':' + hex(device.productId) + ':' + serial;
    }

    function snapshotEndpoints(endpoints) {
        return (endpoints || []).map(function (e) {
            return {
                endpointNumber: e.endpointNumber,
                direction: e.direction,
                type: e.type,
                packetSize: e.packetSize
            };
        });
    }

    function snapshotInterfaces(interfaces) {
        return (interfaces || []).map(function (i) {
            return {
                interfaceNumber: i.interfaceNumber,
                claimed: !!i.claimed,
                alternates: (i.alternates || []).map(function (a) {
                    return {
                        alternateSetting: a.alternateSetting,
                        interfaceClass: a.interfaceClass,
                        interfaceClassHex: hex2(a.interfaceClass),
                        interfaceClassName: className(a.interfaceClass),
                        interfaceSubclass: a.interfaceSubclass,
                        interfaceProtocol: a.interfaceProtocol,
                        interfaceName: a.interfaceName || null,
                        browserProtected: PROTECTED_CLASSES.indexOf(a.interfaceClass) !== -1,
                        endpoints: snapshotEndpoints(a.endpoints)
                    };
                })
            };
        });
    }

    function snapshotConfigurations(configurations) {
        return (configurations || []).map(function (c) {
            return {
                configurationValue: c.configurationValue,
                configurationName: c.configurationName || null,
                interfaces: snapshotInterfaces(c.interfaces)
            };
        });
    }

    function countInterfaces(configs) {
        var total = 0;
        var protectedCount = 0;
        var classes = [];
        configs.forEach(function (c) {
            c.interfaces.forEach(function (i) {
                total += 1;
                i.alternates.forEach(function (a) {
                    if (a.browserProtected) protectedCount += 1;
                    if (classes.indexOf(a.interfaceClassName) === -1) {
                        classes.push(a.interfaceClassName);
                    }
                });
            });
        });
        return { total: total, browserProtected: protectedCount, classes: classes };
    }

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
        if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
        writeJSON(localStorage, EVENTS_KEY, events);
        return events;
    }

    /**
     * Upsert a device into the durable registry.
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
        var configs = snapshotConfigurations(device.configurations);
        var entry = registry[key];

        if (!entry) {
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
                manufacturerName: device.manufacturerName || '(no manufacturer name)',
                // The field WebHID has no equivalent for.
                serialNumber: device.serialNumber || null,
                vendorId: device.vendorId,
                vendorIdHex: hex(device.vendorId),
                vendorName: vendorName(device.vendorId),
                productId: device.productId,
                productIdHex: hex(device.productId),
                deviceClass: device.deviceClass,
                deviceClassHex: hex2(device.deviceClass),
                deviceClassName: className(device.deviceClass),
                deviceSubclass: device.deviceSubclass,
                deviceProtocol: device.deviceProtocol,
                deviceVersion: version(device.deviceVersionMajor, device.deviceVersionMinor,
                                       device.deviceVersionSubminor),
                usbVersion: version(device.usbVersionMajor, device.usbVersionMinor,
                                    device.usbVersionSubminor),
                firstSeen: nowISO(),
                lastSeen: nowISO(),
                timesSeen: 0,
                discoveryMethods: [],
                configurations: configs,
                interfaceSummary: countInterfaces(configs)
            };
        }

        entry.lastSeen = nowISO();
        entry.timesSeen += 1;
        if (entry.discoveryMethods.indexOf(method) === -1) {
            entry.discoveryMethods.push(method);
        }
        entry.configurations = configs;
        entry.interfaceSummary = countInterfaces(configs);

        registry[key] = entry;
        writeJSON(localStorage, REGISTRY_KEY, registry);
        recordEvent(method, key);
        recordSessionSighting(entry, method);
        return entry;
    }

    function recordSessionSighting(entry, method) {
        var arr = readJSON(sessionStorage, SESSION_KEY, []);
        if (!Array.isArray(arr)) arr = [];
        arr.push({
            productName: entry.productName,
            manufacturerName: entry.manufacturerName,
            serialNumber: entry.serialNumber,
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
        var pane = el('usbLog');
        if (!pane) return;
        var line = text('div', '[' + new Date().toLocaleTimeString() + '] ' + message);
        pane.appendChild(line);
        pane.scrollTop = pane.scrollHeight;
    }

    function describeConfigurations(configs, lines) {
        configs.forEach(function (c) {
            lines.push('Configuration ' + c.configurationValue +
                       (c.configurationName ? ' (' + c.configurationName + ')' : ''));
            c.interfaces.forEach(function (i) {
                lines.push('  Interface ' + i.interfaceNumber +
                           (i.claimed ? ' [claimed]' : ''));
                i.alternates.forEach(function (a) {
                    lines.push('    Alt ' + a.alternateSetting + ': ' +
                               a.interfaceClassName + ' (' + a.interfaceClassHex + ')' +
                               ', subclass ' + hex2(a.interfaceSubclass) +
                               ', protocol ' + hex2(a.interfaceProtocol) +
                               (a.browserProtected ? '  [protected]' : ''));
                    if (a.interfaceName) lines.push('      name: ' + a.interfaceName);
                    a.endpoints.forEach(function (e) {
                        lines.push('      Endpoint ' + e.endpointNumber + ' ' +
                                   e.direction + ' ' + e.type + ', ' + e.packetSize + ' byte packets');
                    });
                });
            });
        });
        return lines;
    }

    function renderRegistry() {
        var host = el('usbRegistry');
        if (!host) return;
        host.textContent = '';

        var registry = readJSON(localStorage, REGISTRY_KEY, {});
        var keys = Object.keys(registry);

        var count = el('usbDeviceCount');
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
            card.className = 'usb-device-card';

            card.appendChild(text('h4', d.productName));

            var table = document.createElement('table');
            table.className = 'usb-table';
            var rows = [
                ['Manufacturer', d.manufacturerName],
                ['Serial number', d.serialNumber || 'not reported by this device'],
                ['Vendor', d.vendorIdHex + '  (' + d.vendorName + ')'],
                ['Product', d.productIdHex],
                ['Device class', d.deviceClassHex + '  (' + d.deviceClassName + ')'],
                ['Device version', d.deviceVersion],
                ['USB version', d.usbVersion],
                ['First seen', d.firstSeen],
                ['Last seen', d.lastSeen],
                ['Times seen', String(d.timesSeen)],
                ['How it was seen', d.discoveryMethods.join(', ')],
                ['Interfaces', d.interfaceSummary.total + ' total, ' +
                               d.interfaceSummary.browserProtected + ' the browser blocks'],
                ['Interface classes', d.interfaceSummary.classes.join(', ') || 'none reported']
            ];
            rows.forEach(function (row) {
                var tr = document.createElement('tr');
                tr.appendChild(text('th', row[0]));
                var td = text('td', row[1]);
                // Call out the field WebHID cannot give you at all.
                if (row[0] === 'Serial number' && d.serialNumber) {
                    td.className = 'usb-serial';
                }
                tr.appendChild(td);
                table.appendChild(tr);
            });
            card.appendChild(table);

            var lines = describeConfigurations(d.configurations, []);
            if (lines.length) {
                var details = document.createElement('details');
                details.appendChild(text('summary', 'Configuration tree (' + lines.length + ' lines)'));
                details.appendChild(text('pre', lines.join('\n'), 'usb-descriptor'));
                card.appendChild(details);
            }

            host.appendChild(card);
        });
    }

    function renderTimeline() {
        var host = el('usbTimeline');
        if (!host) return;
        host.textContent = '';

        var events = readJSON(localStorage, EVENTS_KEY, []);
        if (!Array.isArray(events) || events.length === 0) {
            host.appendChild(text('p', 'No events recorded yet.', 'info-text'));
            return;
        }

        var list = document.createElement('ol');
        list.className = 'usb-timeline-list';
        events.slice().reverse().forEach(function (ev) {
            var li = document.createElement('li');
            li.appendChild(text('span', ev.at, 'usb-event-time'));
            li.appendChild(text('span', ev.type, 'usb-event-type'));
            li.appendChild(text('span', ev.device || '', 'usb-event-device'));
            if (ev.note) li.appendChild(text('span', ev.note, 'usb-event-note'));
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
            webUsbSupported: 'usb' in navigator,
            note: 'WebUSB cannot enumerate the USB bus. This record holds only ' +
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
        var header = ['productName', 'manufacturerName', 'serialNumber',
                      'vendorIdHex', 'vendorName', 'productIdHex',
                      'deviceClassName', 'deviceVersion', 'usbVersion',
                      'firstSeen', 'lastSeen', 'timesSeen', 'discoveryMethods',
                      'interfaceCount', 'protectedInterfaces', 'interfaceClasses'];
        var rows = [header.map(csvCell).join(',')];
        Object.keys(registry).forEach(function (key) {
            var d = registry[key];
            rows.push([
                d.productName, d.manufacturerName, d.serialNumber,
                d.vendorIdHex, d.vendorName, d.productIdHex,
                d.deviceClassName, d.deviceVersion, d.usbVersion,
                d.firstSeen, d.lastSeen, d.timesSeen,
                d.discoveryMethods.join(' '),
                d.interfaceSummary.total, d.interfaceSummary.browserProtected,
                d.interfaceSummary.classes.join(' ')
            ].map(csvCell).join(','));
        });
        return rows.join('\r\n');
    }

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
        download('usb-device-record-' + stamp() + '.json', 'application/json',
                 JSON.stringify(buildReport(), null, 2));
    }

    function exportCSV() {
        download('usb-device-record-' + stamp() + '.csv', 'text/csv', buildCSV());
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

    // Clearing the site record does not revoke the browser's permission grant.
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
        var banner = el('usbSupport');
        if (banner) {
            banner.className = 'usb-banner usb-banner-warn';
            banner.textContent = reason;
        }
        writeLog(reason);
    }

    function enumerateGranted() {
        return navigator.usb.getDevices().then(function (devices) {
            if (!devices.length) {
                writeLog('No previously granted USB devices. Use the connect button.');
                return;
            }
            writeLog('Found ' + devices.length + ' device(s) already granted to this origin ' +
                     'with no user action required.');
            devices.forEach(function (device) {
                var entry = recordDevice(device, 'granted-earlier');
                writeLog('Recorded ' + entry.productName + ' (' + entry.vendorIdHex +
                         ':' + entry.productIdHex + ') serial ' +
                         (entry.serialNumber || 'not reported'));
            });
        }, function (err) {
            writeLog('getDevices() failed: ' + err.message);
        });
    }

    function requestDevice() {
        return navigator.usb.requestDevice({ filters: [] }).then(function (device) {
            // requestDevice resolves with a single device, not an array.
            if (!device) {
                writeLog('Chooser dismissed without selecting a device.');
                recordEvent('chooser-dismissed', null);
                render();
                return;
            }
            var entry = recordDevice(device, 'user-selected');
            writeLog('User granted ' + entry.productName + ' (' + entry.vendorIdHex +
                     ':' + entry.productIdHex + ') serial ' +
                     (entry.serialNumber || 'not reported'));
            render();
        }, function (err) {
            writeLog('requestDevice() failed: ' + err.message);
            recordEvent('chooser-error', null, err.message);
            render();
        });
    }

    function wireButtons() {
        var connect = el('usbRequestDeviceButton');
        if (connect) connect.addEventListener('click', requestDevice);

        var map = {
            usbExportJSON: exportJSON,
            usbExportCSV: exportCSV,
            usbCopyJSON: copyJSON,
            usbClearRecord: clearRecord
        };
        Object.keys(map).forEach(function (id) {
            var node = el(id);
            if (node) node.addEventListener('click', map[id]);
        });
    }

    function init() {
        wireButtons();
        render();
    }

    var started = false;

    function start() {
        if (started) return Promise.resolve();
        started = true;

        if (!('usb' in navigator)) {
            showUnsupported('WebUSB is not available in this browser. It is supported in ' +
                            'Chromium browsers (Chrome, Edge) over HTTPS or localhost. ' +
                            'Any record shown below was captured earlier in this profile.');
            var connect = el('usbRequestDeviceButton');
            if (connect) connect.disabled = true;
            return Promise.resolve();
        }

        var banner = el('usbSupport');
        if (banner) {
            banner.className = 'usb-banner usb-banner-ok';
            banner.textContent = 'WebUSB is available. Devices already granted to this origin ' +
                                 'are listed without any user action.';
        }

        navigator.usb.addEventListener('connect', function (e) {
            recordDevice(e.device, 'connect-event');
            writeLog('Device connected: ' + (e.device.productName || 'unnamed device'));
            render();
        });
        navigator.usb.addEventListener('disconnect', function (e) {
            recordEvent('disconnect-event', deviceKey(e.device));
            writeLog('Device disconnected: ' + (e.device.productName || 'unnamed device'));
            render();
        });

        return enumerateGranted().then(render);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.usbRecord = {
        start: start,
        buildReport: buildReport,
        buildCSV: buildCSV,
        recordDevice: recordDevice,
        recordEvent: recordEvent,
        deviceKey: deviceKey,
        snapshotConfigurations: snapshotConfigurations,
        clearRecord: clearRecord,
        render: render
    };
})();
