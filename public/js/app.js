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

    // Recurring
    const btnCreateRecurring = document.getElementById('btn-create-recurring');
    const recurringModal = document.getElementById('recurring-modal');
    const modalClose = document.getElementById('modal-close');
    const btnModalCancel = document.getElementById('btn-modal-cancel');
    const btnModalSave = document.getElementById('btn-modal-save');
    const recurringForm = document.getElementById('recurring-form');
    const formError = document.getElementById('form-error');
    const recurringLoading = document.getElementById('recurring-loading');
    const recurringEmpty = document.getElementById('recurring-empty');
    const recurringTableWrap = document.getElementById('recurring-table-wrap');
    const recurringTbody = document.getElementById('recurring-tbody');
    const formTarget = document.getElementById('form-target');
    const buttonsList = document.getElementById('buttons-list');
    const btnAddButton = document.getElementById('btn-add-button');
    const modalTitle = document.getElementById('modal-title');
    const btnSaveLabel = document.getElementById('btn-save-label');

    // Delete modal
    const deleteModal = document.getElementById('delete-modal');
    const deleteModalClose = document.getElementById('delete-modal-close');
    const btnDeleteCancel = document.getElementById('btn-delete-cancel');
    const btnDeleteConfirm = document.getElementById('btn-delete-confirm');
    const deleteTargetName = document.getElementById('delete-target-name');

    // Console clear
    const btnClearConsole = document.getElementById('btn-clear-console');

    // ─── State ────────────────────────────────────────────────
    let totalBans = 0;
    let hasReceivedBans = false;
    let currentEditId = null;
    let pendingDeleteId = null;
    let recurringItems = [];
    let sectorsLoaded = false;

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
        });

        // Lazy-load recurring page
        if (pageId === 'recurring' && !sectorsLoaded) {
            loadSectors();
            sectorsLoaded = true;
        }
        if (pageId === 'recurring') {
            loadRecurring();
        }
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
    };

    const formatInterval = (item) => {
        const parts = [];
        if (item.intervalWeeks > 0) parts.push(`${item.intervalWeeks}w`);
        if (item.intervalDays > 0) parts.push(`${item.intervalDays}d`);
        if (item.intervalHours > 0) parts.push(`${item.intervalHours}h`);
        return parts.length > 0 ? 'Every ' + parts.join(' ') : '—';
    };

    function showError(msg) {
        formError.textContent = msg;
        formError.classList.remove('hidden');
    }

    function hideError() {
        formError.classList.add('hidden');
        formError.textContent = '';
    }

    async function apiFetch(url, options = {}) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        return json;
    }

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
    // RECURRING MESSAGES — Load Sectors
    // ──────────────────────────────────────────────────────────
    async function loadSectors() {
        try {
            const data = await apiFetch('/api/sectors');
            formTarget.innerHTML = '<option value="">— Select a sector —</option>';
            (data.sectors || []).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = `${s.name} (${s.id})`;
                opt.dataset.name = s.name;
                formTarget.appendChild(opt);
            });
        } catch (e) {
            console.error('Failed to load sectors:', e);
        }
    }

    // ──────────────────────────────────────────────────────────
    // RECURRING MESSAGES — Load List
    // ──────────────────────────────────────────────────────────
    async function loadRecurring() {
        recurringLoading.classList.remove('hidden');
        recurringEmpty.classList.add('hidden');
        recurringTableWrap.classList.add('hidden');

        try {
            const data = await apiFetch('/api/recurring');
            recurringItems = data.items || [];
            renderRecurringTable();
        } catch (e) {
            console.error('Failed to load recurring:', e);
            recurringLoading.classList.add('hidden');
            recurringEmpty.classList.remove('hidden');
        }
    }

    function renderRecurringTable() {
        recurringLoading.classList.add('hidden');

        if (recurringItems.length === 0) {
            recurringEmpty.classList.remove('hidden');
            recurringTableWrap.classList.add('hidden');
            return;
        }

        recurringEmpty.classList.add('hidden');
        recurringTableWrap.classList.remove('hidden');

        recurringTbody.innerHTML = '';

        recurringItems.forEach(item => {
            const tr = document.createElement('tr');
            tr.dataset.id = item._id;

            const statusClass = {
                running: 'status-running',
                paused: 'status-paused',
                error: 'status-error',
                completed: 'status-completed'
            }[item.status] || 'status-paused';

            tr.innerHTML = `
                <td class="name-cell"><span title="${escAttr(item.name)}">${escHtml(item.name)}</span></td>
                <td>${escHtml(item.targetGroupName || item.targetGroupId)}</td>
                <td>${escHtml(formatInterval(item))}</td>
                <td><span class="status-badge ${escAttr(statusClass)}">${escHtml(item.status)}</span></td>
                <td class="mono">${escHtml(formatDate(item.nextRunAt))}</td>
                <td class="mono">${escHtml(formatDate(item.lastSentAt))}</td>
                <td>
                    <div class="action-btns">
                        <label class="toggle-switch" title="${item.enabled ? 'Disable' : 'Enable'}">
                            <input type="checkbox" class="toggle-enabled" data-id="${escAttr(item._id)}" ${item.enabled ? 'checked' : ''}>
                            <div class="toggle-track"><div class="toggle-thumb"></div></div>
                        </label>
                        <button class="icon-btn edit" data-id="${escAttr(item._id)}" title="Edit" aria-label="Edit schedule">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                        </button>
                        <button class="icon-btn delete" data-id="${escAttr(item._id)}" data-name="${escAttr(item.name)}" title="Delete" aria-label="Delete schedule">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
                        </button>
                    </div>
                </td>
            `;
            recurringTbody.appendChild(tr);
        });

        // Toggle enable/disable
        recurringTbody.querySelectorAll('.toggle-enabled').forEach(toggle => {
            toggle.addEventListener('change', async (e) => {
                const id = e.target.dataset.id;
                e.target.disabled = true;
                try {
                    const data = await apiFetch(`/api/recurring/${id}/toggle`, { method: 'PATCH' });
                    updateItemInList(data.item);
                    renderRecurringTable();
                } catch (err) {
                    console.error('Toggle failed:', err);
                    e.target.checked = !e.target.checked; // revert
                } finally {
                    e.target.disabled = false;
                }
            });
        });

        // Edit buttons
        recurringTbody.querySelectorAll('.icon-btn.edit').forEach(btn => {
            btn.addEventListener('click', () => openEditModal(btn.dataset.id));
        });

        // Delete buttons
        recurringTbody.querySelectorAll('.icon-btn.delete').forEach(btn => {
            btn.addEventListener('click', () => openDeleteModal(btn.dataset.id, btn.dataset.name));
        });
    }

    function updateItemInList(updatedItem) {
        const idx = recurringItems.findIndex(i => i._id === updatedItem._id);
        if (idx !== -1) recurringItems[idx] = updatedItem;
        else recurringItems.unshift(updatedItem);
    }

    // Real-time update from socket
    socket.on('recurring:update', (update) => {
        const item = recurringItems.find(i => i._id === update.id);
        if (item) {
            Object.assign(item, update);
            renderRecurringTable();
        }
    });

    // ──────────────────────────────────────────────────────────
    // RECURRING MESSAGES — Modal (Create / Edit)
    // ──────────────────────────────────────────────────────────
    function openCreateModal() {
        currentEditId = null;
        modalTitle.textContent = 'Create Schedule';
        btnSaveLabel.textContent = 'Save Schedule';
        resetForm();
        openModal(recurringModal);
    }

    function openEditModal(id) {
        const item = recurringItems.find(i => i._id === id);
        if (!item) return;
        currentEditId = id;
        modalTitle.textContent = 'Edit Schedule';
        btnSaveLabel.textContent = 'Update Schedule';
        populateForm(item);
        openModal(recurringModal);
    }

    function openModal(modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeModal(modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function resetForm() {
        document.getElementById('form-id').value = '';
        document.getElementById('form-name').value = '';
        formTarget.value = '';
        document.getElementById('form-hours').value = '';
        document.getElementById('form-days').value = '';
        document.getElementById('form-weeks').value = '';
        document.getElementById('form-start').value = '';
        document.getElementById('form-end').value = '';
        document.getElementById('form-message').value = '';
        document.getElementById('form-images').value = '';
        document.getElementById('form-caption').value = '';
        document.getElementById('form-enabled').checked = true;
        buttonsList.innerHTML = '';
        hideError();
    }

    function populateForm(item) {
        document.getElementById('form-id').value = item._id;
        document.getElementById('form-name').value = item.name || '';
        formTarget.value = item.targetGroupId || '';
        document.getElementById('form-hours').value = item.intervalHours || 0;
        document.getElementById('form-days').value = item.intervalDays || 0;
        document.getElementById('form-weeks').value = item.intervalWeeks || 0;
        document.getElementById('form-start').value = item.startAt
            ? new Date(item.startAt).toISOString().slice(0, 16) : '';
        document.getElementById('form-end').value = item.endAt
            ? new Date(item.endAt).toISOString().slice(0, 16) : '';
        document.getElementById('form-message').value = item.messageText || '';
        document.getElementById('form-images').value = (item.imageUrls || []).join('\n');
        document.getElementById('form-caption').value = item.caption || '';
        document.getElementById('form-enabled').checked = item.enabled !== false;
        buttonsList.innerHTML = '';
        (item.buttons || []).forEach(btn => addButtonRow(btn.text, btn.url || btn.callback_data, !!btn.url));
        hideError();
    }

    function addButtonRow(text = '', value = '', isUrl = true) {
        const row = document.createElement('div');
        row.className = 'btn-row';
        row.innerHTML = `
            <input type="text" placeholder="Button text" class="btn-text-input" value="${escAttr(text)}">
            <div class="btn-row-sep"></div>
            <input type="text" placeholder="URL (https://...) or callback_data" class="btn-value-input" value="${escAttr(value)}">
            <button type="button" class="btn-remove" title="Remove button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
        `;
        row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
        buttonsList.appendChild(row);
    }

    function collectFormData() {
        const name = document.getElementById('form-name').value.trim();
        const targetGroupId = formTarget.value;
        const selectedOpt = formTarget.selectedOptions[0];
        const targetGroupName = selectedOpt ? selectedOpt.dataset.name || selectedOpt.text : '';
        const hours = parseFloat(document.getElementById('form-hours').value) || 0;
        const days = parseFloat(document.getElementById('form-days').value) || 0;
        const weeks = parseFloat(document.getElementById('form-weeks').value) || 0;
        const startRaw = document.getElementById('form-start').value;
        const endRaw = document.getElementById('form-end').value;
        const messageText = document.getElementById('form-message').value.trim();
        const imagesRaw = document.getElementById('form-images').value.trim();
        const imageUrls = imagesRaw ? imagesRaw.split('\n').map(l => l.trim()).filter(Boolean) : [];
        const caption = document.getElementById('form-caption').value.trim();
        const enabled = document.getElementById('form-enabled').checked;

        const buttons = [];
        buttonsList.querySelectorAll('.btn-row').forEach(row => {
            const btnText = row.querySelector('.btn-text-input').value.trim();
            const btnValue = row.querySelector('.btn-value-input').value.trim();
            if (btnText) {
                const btn = { text: btnText };
                if (btnValue.startsWith('http')) btn.url = btnValue;
                else if (btnValue) btn.callback_data = btnValue;
                buttons.push(btn);
            }
        });

        return {
            name, targetGroupId, targetGroupName,
            intervalHours: hours, intervalDays: days, intervalWeeks: weeks,
            startAt: startRaw ? new Date(startRaw).toISOString() : new Date().toISOString(),
            endAt: endRaw ? new Date(endRaw).toISOString() : null,
            messageText, imageUrls, caption, buttons, enabled
        };
    }

    async function saveRecurring() {
        hideError();
        const payload = collectFormData();

        // Validation
        if (!payload.name) { showError('Schedule name is required.'); return; }
        if (!payload.targetGroupId) { showError('Please select a target sector.'); return; }
        const totalIntervalH = payload.intervalHours + payload.intervalDays * 24 + payload.intervalWeeks * 168;
        if (totalIntervalH <= 0) { showError('Please set an interval of at least 1 hour.'); return; }
        if (!payload.messageText && payload.imageUrls.length === 0) {
            showError('Please provide a message text or at least one image URL.'); return;
        }

        btnModalSave.disabled = true;
        btnSaveLabel.textContent = 'Saving...';

        try {
            let data;
            if (currentEditId) {
                data = await apiFetch(`/api/recurring/${currentEditId}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
            } else {
                data = await apiFetch('/api/recurring', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
            }
            updateItemInList(data.item);
            renderRecurringTable();
            closeModal(recurringModal);
        } catch (err) {
            showError(err.message || 'An error occurred. Please try again.');
        } finally {
            btnModalSave.disabled = false;
            btnSaveLabel.textContent = currentEditId ? 'Update Schedule' : 'Save Schedule';
        }
    }

    // ──────────────────────────────────────────────────────────
    // RECURRING MESSAGES — Delete
    // ──────────────────────────────────────────────────────────
    function openDeleteModal(id, name) {
        pendingDeleteId = id;
        deleteTargetName.textContent = name;
        openModal(deleteModal);
    }

    async function confirmDelete() {
        if (!pendingDeleteId) return;
        btnDeleteConfirm.disabled = true;
        btnDeleteConfirm.textContent = 'Deleting...';
        try {
            await apiFetch(`/api/recurring/${pendingDeleteId}`, { method: 'DELETE' });
            recurringItems = recurringItems.filter(i => i._id !== pendingDeleteId);
            renderRecurringTable();
            closeModal(deleteModal);
        } catch (err) {
            console.error('Delete failed:', err);
        } finally {
            btnDeleteConfirm.disabled = false;
            btnDeleteConfirm.textContent = 'Delete';
            pendingDeleteId = null;
        }
    }

    // ──────────────────────────────────────────────────────────
    // EVENT LISTENERS
    // ──────────────────────────────────────────────────────────
    btnCreateRecurring.addEventListener('click', openCreateModal);
    btnModalSave.addEventListener('click', saveRecurring);
    modalClose.addEventListener('click', () => closeModal(recurringModal));
    btnModalCancel.addEventListener('click', () => closeModal(recurringModal));

    deleteModalClose.addEventListener('click', () => closeModal(deleteModal));
    btnDeleteCancel.addEventListener('click', () => closeModal(deleteModal));
    btnDeleteConfirm.addEventListener('click', confirmDelete);

    btnAddButton.addEventListener('click', () => addButtonRow());

    // Close modal on overlay click
    recurringModal.addEventListener('click', (e) => {
        if (e.target === recurringModal) closeModal(recurringModal);
    });
    deleteModal.addEventListener('click', (e) => {
        if (e.target === deleteModal) closeModal(deleteModal);
    });

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!recurringModal.classList.contains('hidden')) closeModal(recurringModal);
            if (!deleteModal.classList.contains('hidden')) closeModal(deleteModal);
        }
    });

    // Form submit on Enter (avoid accidental submit)
    recurringForm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') e.preventDefault();
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
