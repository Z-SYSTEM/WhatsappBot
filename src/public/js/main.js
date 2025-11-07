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
    const testMessageForm = document.getElementById('test-message-form');
    const testMessageStatus = document.getElementById('test-message-status');
    const btnLogoutWhatsapp = document.getElementById('btn-logout-whatsapp');
    const btnRefreshQr = document.getElementById('btn-refresh-qr'); // Get the new button

    let qr = null;

    socket.on('connect', () => {
        console.log('Conectado al servidor de UI');
    });

    socket.on('status_update', (data) => {
        console.log('Actualización de estado:', data);
        statusText.textContent = data.message;
        statusIndicator.className = 'status-indicator'; // Reset classes

        if (data.isReady) {
            statusIndicator.classList.add('connected');
            qrContainer.style.display = 'none';
        } else if (data.isConnecting) {
            statusIndicator.classList.add('connecting');
        } else {
            statusIndicator.classList.add('disconnected');
        }
    });

    socket.on('qr_update', (qrCode) => {
        if (qrCode) {
            console.log('QR recibido');
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
            qrContainer.style.display = 'none';
        }
    });

    socket.on('log_entry', (log) => {
        if (!logBox) return;
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${log.level}`;
        
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const levelFormatted = `[${log.level.toUpperCase()}]`.padEnd(7, ' ');

        // Create elements manually to avoid innerHTML issues and preserve formatting
        const timestampSpan = document.createElement('span');
        timestampSpan.className = 'log-timestamp';
        timestampSpan.textContent = timestamp;

        const levelSpan = document.createElement('span');
        levelSpan.className = `log-level log-${log.level}`;
        levelSpan.textContent = levelFormatted;

        const messageSpan = document.createElement('span');
        messageSpan.className = 'log-message';
        messageSpan.textContent = log.message; // textContent automatically handles escaping

        logEntry.appendChild(timestampSpan);
        logEntry.appendChild(document.createTextNode(' ')); // Add space
        logEntry.appendChild(levelSpan);
        logEntry.appendChild(document.createTextNode(' ')); // Add space
        logEntry.appendChild(messageSpan);
        
        // Añadir nueva entrada de log
        logBox.appendChild(logEntry);

        // Mantener solo los 30 mensajes más recientes
        const maxLogEntries = 30;
        while (logBox.children.length > maxLogEntries) {
            logBox.removeChild(logBox.firstChild);
        }

        // Scroll to the bottom to show the latest message
        logBox.scrollTop = logBox.scrollHeight;
    });

    if (btnLogoutWhatsapp) {
        btnLogoutWhatsapp.addEventListener('click', () => {
            if (confirm('¿Estás seguro de que quieres cerrar la sesión de WhatsApp? Esto requerirá escanear un nuevo código QR.')) {
                console.log('Solicitando cierre de sesión de WhatsApp...');
                socket.emit('logout_whatsapp');
            }
        });
    }

    // New event listener for the "Refresh QR" button
    if (btnRefreshQr) {
        btnRefreshQr.addEventListener('click', () => {
            if (confirm('¿Estás seguro de que quieres actualizar el código QR? Esto cerrará la sesión actual de WhatsApp y generará un nuevo QR.')) {
                console.log('Solicitando actualización del código QR...');
                socket.emit('request_qr_refresh');
            }
        });
    }

    if (testMessageForm) {
        testMessageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const phone = document.getElementById('test-phone').value;
            const message = document.getElementById('test-message').value;
            
            testMessageStatus.textContent = 'Enviando...';
            testMessageStatus.className = 'status-info';

            socket.emit('send_test_message', { phone, message });
        });
    }

    socket.on('test_message_result', (data) => {
        if (!testMessageStatus) return;
        if (data.success) {
            testMessageStatus.textContent = `Mensaje enviado a ${data.phone}. ID: ${data.messageId}`;
            testMessageStatus.className = 'status-success';
        } else {
            testMessageStatus.textContent = `Error enviando a ${data.phone}: ${data.error}`;
            testMessageStatus.className = 'status-error';
        }
    });

    socket.on('disconnect', () => {
        console.log('Desconectado del servidor de UI');
        statusText.textContent = 'Conexión con el servidor perdida';
        statusIndicator.className = 'status-indicator disconnected';
    });
});
