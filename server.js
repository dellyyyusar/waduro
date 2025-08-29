const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
app.use(express.json());

let sock = null;
let qrCode = null;
let qrCodeImage = null;
let isConnected = false;
let connectionStatus = 'disconnected';

// Initialize Baileys connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // Nonaktifkan print QR di terminal
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCode = qr;
            connectionStatus = 'qr_ready';
            try {
                // Generate QR code sebagai base64 image
                qrCodeImage = await QRCode.toDataURL(qr);
                console.log('QR Code generated - Access via /qr endpoint');
            } catch (error) {
                console.error('Error generating QR image:', error);
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            
            if (shouldReconnect) {
                connectionStatus = 'reconnecting';
                setTimeout(connectToWhatsApp, 5000); // Delay 5 detik sebelum reconnect
            } else {
                connectionStatus = 'logged_out';
            }
            isConnected = false;
            qrCode = null;
            qrCodeImage = null;
        } else if (connection === 'open') {
            console.log('WhatsApp connection opened');
            isConnected = true;
            connectionStatus = 'connected';
            qrCode = null;
            qrCodeImage = null;
        } else if (connection === 'connecting') {
            connectionStatus = 'connecting';
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Setup message handlers
    setupMessageHandlers();
}

// Static file serving untuk UI sederhana
app.use(express.static('public'));

// Simple HTML interface untuk QR Code
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Baileys QR Code</title>
        <style>
            body { 
                font-family: Arial, sans-serif; 
                max-width: 600px; 
                margin: 0 auto; 
                padding: 20px;
                text-align: center;
            }
            .status { 
                padding: 10px; 
                margin: 10px 0; 
                border-radius: 5px; 
            }
            .connected { background: #d4edda; color: #155724; }
            .disconnected { background: #f8d7da; color: #721c24; }
            .qr-ready { background: #fff3cd; color: #856404; }
            button { 
                padding: 10px 20px; 
                margin: 5px; 
                border: none; 
                border-radius: 5px; 
                cursor: pointer;
            }
            .refresh-btn { background: #007bff; color: white; }
            .restart-btn { background: #dc3545; color: white; }
            #qrcode { margin: 20px 0; }
            .loading { color: #666; }
        </style>
    </head>
    <body>
        <h1>WhatsApp Baileys Connection</h1>
        <div id="status" class="status">Loading...</div>
        <div id="qrcode"></div>
        <button class="refresh-btn" onclick="checkStatus()">Refresh Status</button>
        <button class="restart-btn" onclick="restartConnection()">Restart Connection</button>
        
        <script>
            async function checkStatus() {
                try {
                    const response = await fetch('/status');
                    const data = await response.json();
                    
                    const statusDiv = document.getElementById('status');
                    const qrcodeDiv = document.getElementById('qrcode');
                    
                    statusDiv.className = 'status ' + (data.connected ? 'connected' : 
                        data.hasQR ? 'qr-ready' : 'disconnected');
                    statusDiv.textContent = \`Status: \${data.status} - \${data.connected ? 'Connected' : 'Not Connected'}\`;
                    
                    if (data.hasQR && !data.connected) {
                        qrcodeDiv.innerHTML = '<h3>Scan QR Code:</h3><img src="/qr" style="max-width: 300px;">';
                    } else if (data.connected) {
                        qrcodeDiv.innerHTML = '<h3>✅ WhatsApp Connected!</h3>';
                    } else {
                        qrcodeDiv.innerHTML = '<p class="loading">Waiting for QR code...</p>';
                    }
                } catch (error) {
                    document.getElementById('status').textContent = 'Error: ' + error.message;
                }
            }
            
            async function restartConnection() {
                try {
                    document.getElementById('qrcode').innerHTML = '<p class="loading">Restarting connection...</p>';
                    await fetch('/restart', { method: 'POST' });
                    setTimeout(checkStatus, 3000);
                } catch (error) {
                    alert('Error restarting: ' + error.message);
                }
            }
            
            // Auto refresh every 5 seconds
            setInterval(checkStatus, 5000);
            checkStatus();
        </script>
    </body>
    </html>
    `);
});

// Get connection status
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        status: connectionStatus,
        qrCode: qrCode,
        hasQR: !!qrCode,
        timestamp: new Date().toISOString()
    });
});

// Get QR Code as image
app.get('/qr', (req, res) => {
    if (!qrCodeImage) {
        return res.status(404).json({ 
            error: 'QR code not available', 
            status: connectionStatus 
        });
    }

    // Return as base64 image
    const base64Data = qrCodeImage.split(',')[1];
    const imgBuffer = Buffer.from(base64Data, 'base64');
    
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': imgBuffer.length
    });
    res.end(imgBuffer);
});

// Get QR Code as JSON (base64)
app.get('/qr-json', (req, res) => {
    if (!qrCodeImage) {
        return res.status(404).json({ 
            error: 'QR code not available', 
            status: connectionStatus 
        });
    }

    res.json({
        qrCodeImage: qrCodeImage,
        qrCodeText: qrCode,
        status: connectionStatus,
        timestamp: new Date().toISOString()
    });
});

// Restart connection (force new QR)
app.post('/restart', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        connectionStatus = 'restarting';
        setTimeout(connectToWhatsApp, 2000);
        res.json({ success: true, message: 'Connection restart initiated' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send message
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        // Format phone number (add @s.whatsapp.net if not present)
        const formattedNumber = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        
        const result = await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp
        });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send media message
app.post('/send-media', async (req, res) => {
    try {
        const { to, mediaUrl, mediaType, caption } = req.body;
        
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        const formattedNumber = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        
        let mediaMessage = {};
        
        switch (mediaType) {
            case 'image':
                mediaMessage = { image: { url: mediaUrl }, caption };
                break;
            case 'document':
                mediaMessage = { document: { url: mediaUrl }, caption };
                break;
            case 'audio':
                mediaMessage = { audio: { url: mediaUrl } };
                break;
            case 'video':
                mediaMessage = { video: { url: mediaUrl }, caption };
                break;
            default:
                return res.status(400).json({ error: 'Invalid media type' });
        }
        
        const result = await sock.sendMessage(formattedNumber, mediaMessage);
        
        res.json({
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp
        });
    } catch (error) {
        console.error('Send media error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get chat messages
app.get('/messages/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { limit = 20 } = req.query;
        
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        const formattedChatId = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`;
        const messages = await sock.fetchMessagesFromWA(formattedChatId, parseInt(limit));
        
        res.json({
            success: true,
            messages: messages
        });
    } catch (error) {
        console.error('Fetch messages error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Webhook endpoint for incoming messages (for n8n webhook node)
app.post('/webhook', (req, res) => {
    // This endpoint will be called by the message handler
    res.json({ received: true });
});

// Store multiple webhook URLs untuk different events
let webhookUrls = {
    message: null,
    status: null,
    group: null
};

// Set webhook URL
app.post('/set-webhook', (req, res) => {
    const { url, type = 'message' } = req.body;
    webhookUrls[type] = url;
    res.json({ success: true, webhookUrls });
});

// Get current webhooks
app.get('/webhooks', (req, res) => {
    res.json({ webhookUrls });
});

// Test webhook
app.post('/test-webhook', async (req, res) => {
    const { type = 'message' } = req.body;
    const url = webhookUrls[type];
    
    if (!url) {
        return res.status(400).json({ error: `No webhook URL set for type: ${type}` });
    }

    try {
        const axios = require('axios');
        await axios.post(url, {
            test: true,
            type: 'test_message',
            from: 'test@s.whatsapp.net',
            message: 'Test message from Baileys server',
            timestamp: Date.now(),
            messageId: 'test_' + Date.now()
        });
        res.json({ success: true, message: 'Test webhook sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Message handler untuk setup event listeners
function setupMessageHandlers() {
    if (!sock) return;

    // Handler untuk pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages || [];
        
        for (const message of messages) {
            // Skip pesan dari diri sendiri
            if (message.key.fromMe) continue;
            
            const webhookUrl = webhookUrls.message;
            if (!webhookUrl) {
                console.log('No webhook URL set for messages');
                continue;
            }

            try {
                const axios = require('axios');
                
                // Extract message content
                let messageContent = '';
                let messageType = 'text';
                
                if (message.message?.conversation) {
                    messageContent = message.message.conversation;
                } else if (message.message?.extendedTextMessage?.text) {
                    messageContent = message.message.extendedTextMessage.text;
                } else if (message.message?.imageMessage?.caption) {
                    messageContent = message.message.imageMessage.caption;
                    messageType = 'image';
                } else if (message.message?.videoMessage?.caption) {
                    messageContent = message.message.videoMessage.caption;
                    messageType = 'video';
                } else if (message.message?.documentMessage) {
                    messageContent = message.message.documentMessage.fileName || 'Document';
                    messageType = 'document';
                } else if (message.message?.audioMessage) {
                    messageContent = 'Audio message';
                    messageType = 'audio';
                }

                // Extract contact info
                const contact = message.key.remoteJid;
                const isGroup = contact.includes('@g.us');
                const sender = message.key.participant || contact;

                // Payload untuk n8n
                const payload = {
                    type: 'incoming_message',
                    messageId: message.key.id,
                    from: contact,
                    sender: sender,
                    message: messageContent,
                    messageType: messageType,
                    timestamp: message.messageTimestamp,
                    isGroup: isGroup,
                    raw: message // Full message object untuk advanced processing
                };

                console.log('Sending webhook:', JSON.stringify(payload, null, 2));
                
                await axios.post(webhookUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });
                
                console.log('Webhook sent successfully');
            } catch (error) {
                console.error('Webhook forward error:', error.message);
            }
        }
    });

    // Handler untuk status koneksi
    sock.ev.on('connection.update', async (update) => {
        const webhookUrl = webhookUrls.status;
        if (!webhookUrl) return;

        try {
            const axios = require('axios');
            await axios.post(webhookUrl, {
                type: 'connection_update',
                connection: update.connection,
                lastDisconnect: update.lastDisconnect,
                qr: !!update.qr,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Status webhook error:', error.message);
        }
    });

    // Handler untuk grup events
    sock.ev.on('groups.upsert', async (groups) => {
        const webhookUrl = webhookUrls.group;
        if (!webhookUrl) return;

        try {
            const axios = require('axios');
            await axios.post(webhookUrl, {
                type: 'group_created',
                groups: groups,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Group webhook error:', error.message);
        }
    });
}

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`Baileys API server running on port ${PORT}`);
    await connectToWhatsApp();
});

module.exports = app;