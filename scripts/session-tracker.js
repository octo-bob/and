(function () {
    var log = [];
    var saved = sessionStorage.getItem('activityLog');
    if (saved) {
        try {
            log = JSON.parse(saved);
        } catch (e) {
            log = [];
        }
    }

    log.push({
        page: location.pathname,
        title: document.title,
        timestamp: new Date().toISOString(),
        referrer: document.referrer
    });

    sessionStorage.setItem('activityLog', JSON.stringify(log));

    // Session cookie tracking unique pages visited
    var uniquePages = [];
    log.forEach(function (entry) {
        if (uniquePages.indexOf(entry.page) === -1) {
            uniquePages.push(entry.page);
        }
    });
    document.cookie = 'uniquePagesVisited=' + uniquePages.length + '; path=/; SameSite=Lax';
})();
