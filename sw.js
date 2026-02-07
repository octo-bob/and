// Service Worker for Aquatic Nature Discovery
// Implements Cache API for offline support

const STATIC_CACHE = 'aquarium-static-v3';
const DYNAMIC_CACHE = 'aquarium-dynamic-v3';
const IMAGE_CACHE = 'aquarium-images-v3';

// Assets to cache immediately on install
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/scripts/dark-mode.js',
    '/exhibits.html',
    '/visit.html',
    '/support.html',
    '/conservation.html',
    '/education.html',
    '/events.html',
    '/giftshop.html',
    '/membership.html',
    '/trip-planner.html',
    '/offline.html',
    '/images/and-logo.png',
    '/scripts/sqlite-worker.js'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                return self.skipWaiting();
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            return name !== STATIC_CACHE &&
                                   name !== DYNAMIC_CACHE &&
                                   name !== IMAGE_CACHE;
                        })
                        .map((name) => {
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip chrome-extension and other non-http(s) requests
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // Handle different types of requests
    if (isImageRequest(request)) {
        event.respondWith(handleImageRequest(request));
    } else if (isStaticAsset(url)) {
        event.respondWith(handleStaticRequest(request));
    } else {
        event.respondWith(handleDynamicRequest(request));
    }
});

// Check if request is for an image
function isImageRequest(request) {
    const url = new URL(request.url);
    return request.destination === 'image' ||
           /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url.pathname);
}

// Check if request is for a static asset
function isStaticAsset(url) {
    return STATIC_ASSETS.some(asset =>
        url.pathname === asset || url.pathname.endsWith(asset)
    );
}

// Handle static asset requests (cache-first strategy)
async function handleStaticRequest(request) {
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        return caches.match('/offline.html');
    }
}

// Handle image requests (cache-first with network fallback)
async function handleImageRequest(request) {
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(IMAGE_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        // Return a placeholder or transparent pixel
        return new Response('', { status: 404 });
    }
}

// Handle dynamic requests (network-first with cache fallback)
async function handleDynamicRequest(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        // Return offline page for navigation requests
        if (request.mode === 'navigate') {
            return caches.match('/offline.html');
        }

        return new Response('Offline', { status: 503 });
    }
}

// Message handler for cache operations
self.addEventListener('message', (event) => {
    const { type, data } = event.data;

    switch (type) {
        case 'GET_CACHE_INFO':
            getCacheInfo().then(info => {
                event.ports[0].postMessage(info);
            });
            break;

        case 'CLEAR_CACHE':
            clearCache(data).then(result => {
                event.ports[0].postMessage(result);
            });
            break;

        case 'CACHE_URL':
            cacheUrl(data).then(result => {
                event.ports[0].postMessage(result);
            });
            break;

        case 'SKIP_WAITING':
            self.skipWaiting();
            break;
    }
});

// Get cache information
async function getCacheInfo() {
    const cacheNames = await caches.keys();
    const info = {};

    for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        info[name] = {
            count: keys.length,
            urls: keys.map(req => req.url)
        };
    }

    return info;
}

// Clear specific cache or all caches
async function clearCache(cacheName) {
    if (cacheName) {
        await caches.delete(cacheName);
        return { success: true, message: `Cache ${cacheName} cleared` };
    } else {
        const names = await caches.keys();
        await Promise.all(names.map(name => caches.delete(name)));
        return { success: true, message: 'All caches cleared' };
    }
}

// Cache a specific URL
async function cacheUrl(url) {
    try {
        const response = await fetch(url);
        const cache = await caches.open(DYNAMIC_CACHE);
        await cache.put(url, response);
        return { success: true, message: `Cached: ${url}` };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

