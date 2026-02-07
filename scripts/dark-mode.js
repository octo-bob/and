(function() {
    function getCookie(name) {
        var nameEQ = name + "=";
        var ca = document.cookie.split(';');
        for (var i = 0; i < ca.length; i++) {
            var c = ca[i].trim();
            if (c.indexOf(nameEQ) === 0) {
                return decodeURIComponent(c.substring(nameEQ.length));
            }
        }
        return null;
    }

    function setCookie(name, value, days) {
        var expires = new Date();
        expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
        document.cookie = name + "=" + encodeURIComponent(value) + ";expires=" + expires.toUTCString() + ";path=/;SameSite=Lax";
    }

    // Apply dark mode from cookie before page renders visually
    var saved = getCookie('darkMode');
    if (saved === 'true') {
        document.body.classList.add('dark-mode');
    }

    // Create toggle button with inline styles to guarantee consistent positioning
    var btn = document.createElement('button');
    btn.className = 'dark-mode-toggle';
    btn.title = 'Toggle Dark Mode';
    btn.setAttribute('type', 'button');
    btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:10000;background:#0066cc;color:white;border:none;padding:12px 16px;border-radius:50px;cursor:pointer;font-size:1.2rem;box-shadow:0 4px 15px rgba(0,0,0,0.2);transition:all 0.3s ease;';
    btn.textContent = document.body.classList.contains('dark-mode') ? '\u2600\uFE0F' : '\uD83C\uDF19';
    document.body.appendChild(btn);

    btn.addEventListener('mouseenter', function() {
        btn.style.transform = 'scale(1.1)';
        btn.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
    });
    btn.addEventListener('mouseleave', function() {
        btn.style.transform = '';
        btn.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
    });

    btn.addEventListener('click', function() {
        var isDark = !document.body.classList.contains('dark-mode');
        if (isDark) {
            document.body.classList.add('dark-mode');
            btn.textContent = '\u2600\uFE0F';
            btn.style.background = '#4da8ff';
            btn.style.color = '#1a1a2e';
        } else {
            document.body.classList.remove('dark-mode');
            btn.textContent = '\uD83C\uDF19';
            btn.style.background = '#0066cc';
            btn.style.color = 'white';
        }
        setCookie('darkMode', isDark.toString(), 365);
    });

    // Apply dark mode button color if already in dark mode
    if (document.body.classList.contains('dark-mode')) {
        btn.style.background = '#4da8ff';
        btn.style.color = '#1a1a2e';
    }
})();
