document.addEventListener('DOMContentLoaded', () => {
    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
    });

    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    const qrContainer = document.getElementById('qr-container');
    const qrCanvas = document.getElementById('qr-canvas');
    const logBox = document.getElementById('log-box');
    const sendMessageForm = document.getElementById('send-message-form');
    const sendMessageContainer = document.querySelector('.send-message-container');
    const sendMessageStatus = document.getElementById('send-message-status');
    const contactInfoForm = document.getElementById('contact-info-form');
    const contactInfoContainer = document.querySelector('.contact-info-container');
    const contactInfoStatus = document.getElementById('contact-info-status');
    const contactResult = document.getElementById('contact-result');
    const contactPhoto = document.getElementById('contact-photo');
    const contactName = document.getElementById('contact-name');
    const contactNumber = document.getElementById('contact-number');
    const btnLogoutWhatsapp = document.getElementById('btn-logout-whatsapp');
    const btnStartBot = document.getElementById('btn-start-bot');
    const btnStopBot = document.getElementById('btn-stop-bot');
    const btnClearLog = document.getElementById('btn-clear-log');

    let qr = null;
    let currentState = {
        isReady: false,
        isConnecting: false,
        hasQR: false
    };

    const maxLogEntries = 10000;
    const LOG_LEVELS = ['info', 'warn', 'error', 'debug', 'message'];
    const FILTER_STORAGE_KEY = 'logLevelFilters';

    function getLogFilters() {
        try {
            const raw = localStorage.getItem(FILTER_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return { info: true, warn: true, error: true, debug: true, message: true, ...parsed };
            }
        } catch (_) {}
        return { info: true, warn: true, error: true, debug: true, message: true };
    }

    function saveLogFilters(filters) {
        try {
            localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
        } catch (_) {}
    }

    function applyLogFiltersToDOM() {
        const filters = getLogFilters();
        if (!logBox) return;
        logBox.querySelectorAll('.log-entry').forEach((el) => {
            const level = el.dataset.level || 'info';
            el.style.display = filters[level] !== false ? '' : 'none';
        });
    }

    /**
     * Añade una entrada de log al logBox (usado por log_entry y log_history)
     */
    function appendLogEntry(log, scrollToBottom = true) {
        if (!logBox) return;
        const level = (log.level || 'info').toLowerCase();
        const filters = getLogFilters();
        let direction = log.direction;
        if (!direction && level === 'message' && log.message) {
            if (log.message.startsWith('▶')) direction = 'in';
            else if (log.message.startsWith('◀')) direction = 'out';
        }
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${level}` + (direction ? ` log-message-${direction}` : '');
        logEntry.dataset.level = level;
        logEntry.style.display = filters[level] !== false ? '' : 'none';

        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const levelFormatted = `[${level.toUpperCase()}]`.padEnd(7, ' ');

        const timestampSpan = document.createElement('span');
        timestampSpan.className = 'log-timestamp';
        timestampSpan.textContent = timestamp;

        const levelSpan = document.createElement('span');
        levelSpan.className = `log-level log-${level}`;
        levelSpan.textContent = levelFormatted;

        let messageText = log.message || '';
        if (direction) {
            const arrowSpan = document.createElement('span');
            arrowSpan.className = `log-arrow log-arrow-${direction}`;
            arrowSpan.textContent = direction === 'in' ? '▶' : '◀';
            logEntry.appendChild(timestampSpan);
            logEntry.appendChild(document.createTextNode(' '));
            logEntry.appendChild(levelSpan);
            logEntry.appendChild(document.createTextNode(' '));
            logEntry.appendChild(arrowSpan);
            const messageSpan = document.createElement('span');
            messageSpan.className = 'log-message';
            messageSpan.textContent = (messageText.startsWith('▶ ') || messageText.startsWith('◀ ')) ? messageText.slice(2) : messageText;
            logEntry.appendChild(document.createTextNode(' '));
            logEntry.appendChild(messageSpan);
        } else {
            const messageSpan = document.createElement('span');
            messageSpan.className = 'log-message';
            messageSpan.textContent = messageText;
            logEntry.appendChild(timestampSpan);
            logEntry.appendChild(document.createTextNode(' '));
            logEntry.appendChild(levelSpan);
            logEntry.appendChild(document.createTextNode(' '));
            logEntry.appendChild(messageSpan);
        }

        logBox.appendChild(logEntry);

        while (logBox.children.length > maxLogEntries) {
            logBox.removeChild(logBox.firstChild);
        }

        if (scrollToBottom) {
            logBox.scrollTop = logBox.scrollHeight;
        }
    }

    /**
     * Actualiza la visibilidad de los botones según el estado del bot
     */
    function updateButtonVisibility() {
        // Bot conectado: mostrar "Detener Bot" y "Cerrar Sesión WhatsApp"
        if (currentState.isReady) {
            if (btnStartBot) btnStartBot.style.display = 'none';
            if (btnStopBot) btnStopBot.style.display = 'inline-block';
            if (btnLogoutWhatsapp) btnLogoutWhatsapp.style.display = 'inline-block';
        }
        // Bot conectando (esperando QR): ocultar todos los botones de acción
        else if (currentState.isConnecting || currentState.hasQR) {
            if (btnStartBot) btnStartBot.style.display = 'none';
            if (btnStopBot) btnStopBot.style.display = 'none';
            if (btnLogoutWhatsapp) btnLogoutWhatsapp.style.display = 'none';
        }
        // Bot desconectado: mostrar solo "Iniciar Bot"
        else {
            if (btnStartBot) btnStartBot.style.display = 'inline-block';
            if (btnStopBot) btnStopBot.style.display = 'none';
            if (btnLogoutWhatsapp) btnLogoutWhatsapp.style.display = 'none';
        }
    }

    socket.on('connect', () => {
        console.log('Conectado al servidor de UI');
        updateButtonVisibility();
        socket.emit('request_log_history');
    });

    socket.on('status_update', (data) => {
        console.log('Actualización de estado:', data);
        statusText.textContent = data.message;
        statusIndicator.className = 'status-dot'; // Reset classes

        // Actualizar estado actual
        currentState.isReady = data.isReady || false;
        currentState.isConnecting = data.isConnecting || false;

        if (data.isReady) {
            statusIndicator.classList.add('connected');
            qrContainer.style.display = 'none';
            if (sendMessageContainer) sendMessageContainer.style.display = 'block';
            if (contactInfoContainer) contactInfoContainer.style.display = 'block';
        } else if (data.isConnecting) {
            statusIndicator.classList.add('connecting');
            if (sendMessageContainer) sendMessageContainer.style.display = 'none';
            if (contactInfoContainer) contactInfoContainer.style.display = 'none';
        } else {
            statusIndicator.classList.add('disconnected');
            if (sendMessageContainer) sendMessageContainer.style.display = 'none';
            if (contactInfoContainer) contactInfoContainer.style.display = 'none';
        }

        // Actualizar visibilidad de botones
        updateButtonVisibility();
    });

    socket.on('qr_update', (qrCode) => {
        if (qrCode) {
            console.log('QR recibido');
            currentState.hasQR = true;
            qrContainer.style.display = 'block';
            if (qr) {
                qr.value = qrCode;
            } else {
                qr = new QRious({
                    element: qrCanvas,
                    value: qrCode,
                    size: 250,
                    padding: 10,
                    foreground: '#333',
                    background: '#fff'
                });
            }
        } else {
            console.log('QR borrado');
            currentState.hasQR = false;
            qrContainer.style.display = 'none';
        }

        // Actualizar visibilidad de botones cuando cambia el estado del QR
        updateButtonVisibility();
    });

    socket.on('log_history', (logs) => {
        if (!logBox || !Array.isArray(logs)) return;
        logs.forEach((log) => appendLogEntry(log, false));
        applyLogFiltersToDOM();
        logBox.scrollTop = logBox.scrollHeight;
    });

    socket.on('log_entry', (log) => {
        appendLogEntry(log, true);
    });

    if (btnLogoutWhatsapp) {
        btnLogoutWhatsapp.addEventListener('click', () => {
            console.log('Solicitando cierre de sesión de WhatsApp...');
            socket.emit('logout_whatsapp');
        });
    }

    if (btnStartBot) {
        btnStartBot.addEventListener('click', () => {
            console.log('Solicitando inicio del bot...');
            socket.emit('start_bot');
        });
    }

    if (btnStopBot) {
        btnStopBot.addEventListener('click', () => {
            console.log('Solicitando detención del bot...');
            socket.emit('stop_bot');
        });
    }

    LOG_LEVELS.forEach((level) => {
        const cb = document.getElementById(`filter-${level}`);
        if (!cb) return;
        const filters = getLogFilters();
        cb.checked = filters[level] !== false;
        cb.addEventListener('change', () => {
            const f = getLogFilters();
            f[level] = cb.checked;
            saveLogFilters(f);
            applyLogFiltersToDOM();
        });
    });

    if (btnClearLog) {
        btnClearLog.addEventListener('click', () => {
            if (logBox) {
                logBox.innerHTML = '';
            }
        });
    }

    const btnScrollBottom = document.getElementById('btn-scroll-bottom');
    if (btnScrollBottom && logBox) {
        btnScrollBottom.addEventListener('click', () => {
            logBox.scrollTop = logBox.scrollHeight;
        });
    }

    if (sendMessageForm) {
        sendMessageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const phone = document.getElementById('send-phone').value;
            const message = document.getElementById('send-message').value;
            
            sendMessageStatus.textContent = 'Enviando...';
            sendMessageStatus.className = 'status-info';

            socket.emit('send_test_message', { phone, message });
        });
    }

    socket.on('test_message_result', (data) => {
        if (!sendMessageStatus) return;
        if (data.success) {
            sendMessageStatus.textContent = `Mensaje enviado a ${data.phone}. ID: ${data.messageId}`;
            sendMessageStatus.className = 'status-success';
            // Limpiar formulario después de éxito
            sendMessageForm.reset();
        } else {
            sendMessageStatus.textContent = `Error enviando a ${data.phone}: ${data.error}`;
            sendMessageStatus.className = 'status-error';
        }
    });

    if (contactInfoForm) {
        contactInfoForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const phone = document.getElementById('contact-phone').value;
            
            contactInfoStatus.textContent = 'Obteniendo información...';
            contactInfoStatus.className = 'status-info';
            contactResult.classList.remove('show');

            socket.emit('get_contact_info', { phone });
        });
    }

    socket.on('contact_info_result', (data) => {
        if (!contactInfoStatus) return;
        
        if (data.success && data.contact) {
            contactInfoStatus.textContent = 'Información obtenida correctamente';
            contactInfoStatus.className = 'status-success';
            
            // Mostrar información del contacto
            const contact = data.contact;
            contactName.textContent = contact.name || 'Sin nombre';
            contactNumber.textContent = contact.number || contact.id || 'N/A';
            
            // Mostrar foto si está disponible
            if (contact.profilePicUrl) {
                contactPhoto.src = contact.profilePicUrl;
                contactPhoto.style.display = 'block';
            } else {
                contactPhoto.style.display = 'none';
            }
            
            contactResult.classList.add('show');
            // Limpiar formulario después de éxito
            contactInfoForm.reset();
        } else {
            contactInfoStatus.textContent = `Error: ${data.error || 'No se pudo obtener la información del contacto'}`;
            contactInfoStatus.className = 'status-error';
            contactResult.classList.remove('show');
        }
    });

    socket.on('disconnect', () => {
        console.log('Desconectado del servidor de UI');
        statusText.textContent = 'Conexión con el servidor perdida';
        statusIndicator.className = 'status-dot disconnected';
        
        // Resetear estado y ocultar todos los botones de acción cuando se pierde conexión con el servidor
        currentState.isReady = false;
        currentState.isConnecting = false;
        currentState.hasQR = false;
        updateButtonVisibility();
    });
});
