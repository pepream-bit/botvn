document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const storybanContainer = document.getElementById('storyban-container');
    const banCountEl = document.getElementById('ban-count');
    
    let totalBans = 0;
    let hasReceivedBans = false;

    // Helper to get initials for avatar
    const getInitials = (name) => {
        if (!name) return '?';
        const parts = name.split(' ').filter(p => p.length > 0);
        if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    };

    // Create a new Storyban card
    const createStorybanCard = (data) => {
        const card = document.createElement('div');
        card.className = 'ban-card slide-in';
        
        // Target (User) Column
        const userCol = document.createElement('div');
        userCol.className = 'user-info';
        
        const avatar = document.createElement('div');
        avatar.className = 'user-avatar';
        avatar.textContent = getInitials(data.user);
        
        const userDetails = document.createElement('div');
        userDetails.className = 'user-details';
        
        const userName = document.createElement('span');
        userName.className = 'user-name';
        userName.innerHTML = data.user; // Use innerHTML in case there are some HTML tags, though it should be plain text
        
        const userId = document.createElement('span');
        userId.className = 'user-id';
        userId.textContent = `ID: ${data.userId}`;
        
        userDetails.appendChild(userName);
        userDetails.appendChild(userId);
        userCol.appendChild(avatar);
        userCol.appendChild(userDetails);

        // Sector Column
        const sectorCol = document.createElement('div');
        sectorCol.className = 'sector-info';
        
        const sectorBadge = document.createElement('span');
        sectorBadge.className = 'sector-badge';
        sectorBadge.textContent = data.sector || 'Unknown Sector';
        
        sectorCol.appendChild(sectorBadge);

        // Time Column
        const timeCol = document.createElement('div');
        timeCol.className = 'time-info';
        
        // Parse time or use the provided TH timestamp
        let displayTime = data.time;
        if (!displayTime && data.timestamp) {
            const date = new Date(data.timestamp);
            displayTime = date.toLocaleTimeString('en-US', { hour12: false });
        }
        timeCol.textContent = displayTime;

        card.appendChild(userCol);
        card.appendChild(sectorCol);
        card.appendChild(timeCol);

        return card;
    };

    // Listen for incoming storyban events
    socket.on('storyban', (data) => {
        // Remove empty state if this is the first ban
        if (!hasReceivedBans) {
            const emptyState = storybanContainer.querySelector('.empty-state');
            if (emptyState) {
                emptyState.style.display = 'none';
            }
            hasReceivedBans = true;
        }

        const card = createStorybanCard(data);
        
        // Prepend to show newest at the top
        storybanContainer.insertBefore(card, storybanContainer.firstChild);
        
        // Keep only the latest 100 bans to prevent memory leaks
        if (storybanContainer.children.length > 100) {
            storybanContainer.removeChild(storybanContainer.lastChild);
        }

        // Update count
        totalBans++;
        banCountEl.textContent = totalBans;
    });

    // Connection status events
    socket.on('connect', () => {
        const dot = document.querySelector('.status-dot');
        const text = document.querySelector('.status-text');
        
        dot.style.backgroundColor = 'var(--success-green)';
        dot.style.boxShadow = '0 0 10px var(--success-green)';
        dot.style.animation = 'blink 2s infinite';
        
        text.textContent = 'Uplink Active';
        text.style.color = 'var(--success-green)';
    });

    socket.on('disconnect', () => {
        const dot = document.querySelector('.status-dot');
        const text = document.querySelector('.status-text');
        
        dot.style.backgroundColor = 'var(--accent-red)';
        dot.style.boxShadow = '0 0 10px var(--accent-red)';
        dot.style.animation = 'none';
        
        text.textContent = 'Connection Lost';
        text.style.color = 'var(--accent-red)';
    });
});
