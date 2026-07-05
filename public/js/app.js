document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const logContainer = document.getElementById('log-container');
    const filterBtns = document.querySelectorAll('.filter-btn');
    
    let currentFilter = 'all';

    // Format time for logs (HH:MM:SS)
    const formatTime = (isoString) => {
        const date = new Date(isoString);
        return date.toLocaleTimeString('en-US', { hour12: false });
    };

    // Create a new log element
    const createLogElement = (log) => {
        const el = document.createElement('div');
        el.className = `log-entry ${log.type} fade-in`;
        el.dataset.type = log.type;

        // Apply filter display rule
        if (currentFilter !== 'all' && currentFilter !== log.type && !(currentFilter === 'info' && log.type === 'log')) {
            el.style.display = 'none';
        }

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = formatTime(log.timestamp);

        const badgeSpan = document.createElement('span');
        badgeSpan.className = `log-badge ${log.type}`;
        badgeSpan.textContent = log.type.toUpperCase();

        const msgSpan = document.createElement('span');
        msgSpan.className = 'log-msg';
        msgSpan.textContent = log.message;

        el.appendChild(timeSpan);
        el.appendChild(badgeSpan);
        el.appendChild(msgSpan);

        return el;
    };

    // Auto-scroll to bottom function
    const scrollToBottom = () => {
        logContainer.scrollTop = logContainer.scrollHeight;
    };

    // Listen for incoming logs from server
    socket.on('log', (log) => {
        const logEl = createLogElement(log);
        logContainer.appendChild(logEl);
        
        // Remove oldest if there are too many logs (e.g., > 1000)
        if (logContainer.children.length > 1000) {
            logContainer.removeChild(logContainer.firstChild);
        }

        // Only auto-scroll if user is near the bottom
        const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 50;
        if (isScrolledToBottom) {
            scrollToBottom();
        }
    });

    // Handle filter buttons
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active state
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            currentFilter = btn.dataset.filter;
            
            // Apply filter to existing logs
            const logs = logContainer.querySelectorAll('.log-entry');
            logs.forEach(logEl => {
                const type = logEl.dataset.type;
                if (currentFilter === 'all') {
                    logEl.style.display = 'grid';
                } else if (currentFilter === type || (currentFilter === 'info' && type === 'log')) {
                    logEl.style.display = 'grid';
                } else {
                    logEl.style.display = 'none';
                }
            });
            scrollToBottom();
        });
    });

    // Connection status events
    socket.on('connect', () => {
        const pulse = document.querySelector('.pulse');
        const statusText = document.querySelector('.status-text');
        pulse.style.backgroundColor = '#10b981'; // Green
        pulse.style.animation = 'pulse-animation 2s infinite';
        statusText.textContent = 'System Online';
        statusText.style.color = '#10b981';
    });

    socket.on('disconnect', () => {
        const pulse = document.querySelector('.pulse');
        const statusText = document.querySelector('.status-text');
        pulse.style.backgroundColor = '#ef4444'; // Red
        pulse.style.animation = 'none';
        statusText.textContent = 'Disconnected';
        statusText.style.color = '#ef4444';
        
        // Add a disconnect log
        logContainer.appendChild(createLogElement({
            type: 'error',
            message: 'Lost connection to server.',
            timestamp: new Date().toISOString()
        }));
    });
});
