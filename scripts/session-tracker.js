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
})();
