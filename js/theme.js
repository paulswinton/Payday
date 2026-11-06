// Apply the saved theme before the page draws, so there is no flash.
try { const t = localStorage.getItem('payday-theme'); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage unavailable */ }
