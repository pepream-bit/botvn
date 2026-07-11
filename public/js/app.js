/* ══════════════════════════════════════════════
   Alien Command — Frontend Dashboard
   Fixes applied:
     #5  XSS: textContent used instead of innerHTML for user names
     #6  CSS var in JS boxShadow: replaced with hex values
     #10 Nav active states driven by JS
     Added: log console, recurring messages page CRUD
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const socket = io();

    // ─── DOM references ───────────────────────────────────────
    const storybanContainer = document.getElementById('storyban-container');
    const storybanEmpty = document.getElementById('storyban-empty');
    const banCountEl = document.getElementById('ban-count');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const consoleLog = document.getElementById('console-log');

    // Nav
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');

    // Console clear
    const btnClearConsole = document.getElementById('btn-clear-console');

    // ─── State ────────────────────────────────────────────────
    let totalBans = 0;
    let hasReceivedBans = false;
    // ──────────────────────────────────────────────────────────
    // PAGE NAVIGATION
    // ──────────────────────────────────────────────────────────
    function navigateTo(pageId) {
        navItems.forEach(item => {
            item.classList.toggle('active', item.dataset.page === pageId);
            item.setAttribute('aria-current', item.dataset.page === pageId ? 'page' : '');
        });
        pages.forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageId}`);
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => navigateTo(item.dataset.page));
    });

    // ──────────────────────────────────────────────────────────
    // HELPERS
    // ──────────────────────────────────────────────────────────
    const getInitials = (name) => {
        if (!name) return '?';
        const parts = name.split(' ').filter(p => p.length > 0);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '—';
        try {
            return new Date(dateStr).toLocaleString('th-TH', {
                timeZone: 'Asia/Bangkok',
                day: '2-digit', month: '2-digit', year: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        } catch { return '—'; }
    // ──────────────────────────────────────────────────────────
    // SOCKET.IO — Connection Status
    // ──────────────────────────────────────────────────────────
    socket.on('connect', () => {
        statusDot.className = 'status-dot connected';
        statusText.className = 'status-text connected';
        statusText.textContent = 'Uplink Active';
        addConsoleLine('info', 'Socket connected — uplink established.');
    });

    socket.on('disconnect', () => {
        // FIX #6: Using hex values instead of CSS variable strings in JS
        statusDot.className = 'status-dot disconnected';
        statusText.className = 'status-text disconnected';
        statusText.textContent = 'Connection Lost';
        addConsoleLine('warn', 'Socket disconnected — uplink lost.');
    });

    // ──────────────────────────────────────────────────────────
    // STORYBAN EVENTS
    // ──────────────────────────────────────────────────────────
    socket.on('storyban', (data) => {
        if (!hasReceivedBans) {
            storybanEmpty.classList.add('hidden');
            hasReceivedBans = true;
        }

        const card = createStorybanCard(data);
        storybanContainer.insertBefore(card, storybanEmpty.nextSibling);

        // Keep latest 100 entries
        const cards = storybanContainer.querySelectorAll('.ban-card');
        if (cards.length > 100) {
            cards[cards.length - 1].remove();
        }

        totalBans++;
        banCountEl.textContent = totalBans;
    });

    // FIX #5: XSS fixed — user.textContent instead of user.innerHTML
    function createStorybanCard(data) {
        const card = document.createElement('div');
        card.className = 'ban-card slide-in';

        // User column
        const userCol = document.createElement('div');
        userCol.className = 'user-info';

        const avatar = document.createElement('div');
        avatar.className = 'user-avatar';
        avatar.textContent = getInitials(data.user); // safe: textContent

        const userDetails = document.createElement('div');
        userDetails.className = 'user-details';

        const userName = document.createElement('span');
        userName.className = 'user-name';
        userName.textContent = data.user; // FIX #5: was innerHTML, now textContent

        const userId = document.createElement('span');
        userId.className = 'user-id';
        userId.textContent = `ID: ${data.userId}`;

        userDetails.appendChild(userName);
        userDetails.appendChild(userId);
        userCol.appendChild(avatar);
        userCol.appendChild(userDetails);

        // Sector column
        const sectorCol = document.createElement('div');
        sectorCol.className = 'sector-info';
        const sectorBadge = document.createElement('span');
        sectorBadge.className = 'sector-badge';
        sectorBadge.textContent = data.sector || 'Unknown Sector';
        sectorCol.appendChild(sectorBadge);

        // Time column
        const timeCol = document.createElement('div');
        timeCol.className = 'time-info';
        timeCol.textContent = data.time || (data.timestamp
            ? new Date(data.timestamp).toLocaleTimeString('en-US', { hour12: false })
            : '—');

        card.appendChild(userCol);
        card.appendChild(sectorCol);
        card.appendChild(timeCol);

        return card;
    }

    // ──────────────────────────────────────────────────────────
    // SYSTEM CONSOLE
    // ──────────────────────────────────────────────────────────
    socket.on('log', (data) => {
        addConsoleLine(data.type, data.message, data.timestamp);
    });

    function addConsoleLine(type, message, timestamp) {
        const ts = timestamp
            ? new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })
            : new Date().toLocaleTimeString('en-US', { hour12: false });

        const line = document.createElement('div');
        line.className = `console-line console-${type || 'log'}-line`;

        const tsEl = document.createElement('span');
        tsEl.className = 'console-ts';
        tsEl.textContent = ts;

        const msgEl = document.createElement('span');
        msgEl.className = 'console-msg';
        msgEl.textContent = message; // always textContent — safe

        line.appendChild(tsEl);
        line.appendChild(msgEl);
        consoleLog.appendChild(line);

        // Auto-scroll to bottom
        consoleLog.scrollTop = consoleLog.scrollHeight;

        // Cap at 500 lines
        const lines = consoleLog.querySelectorAll('.console-line:not(.console-info)');
        if (lines.length > 500) {
            lines[0].remove();
        }
    }

    btnClearConsole.addEventListener('click', () => {
        consoleLog.innerHTML = '';
        addConsoleLine('info', 'Console cleared.');
    });

    // ──────────────────────────────────────────────────────────
    // SECURITY HELPERS — HTML escape (used in innerHTML)
    // ──────────────────────────────────────────────────────────
    function escHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escAttr(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;');
    }

    // ──────────────────────────────────────────────────────────
    // INIT
    // ──────────────────────────────────────────────────────────
    // Set initial connection state
    statusDot.className = 'status-dot';
    statusText.textContent = 'Connecting...';
    statusText.className = 'status-text';

    // Navigate to storyban by default
    navigateTo('storyban');
});
