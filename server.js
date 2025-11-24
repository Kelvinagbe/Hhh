// server.js
const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active connections
const activeConnections = new Map();

/**
 * Create ZIP file of session credentials
 */
async function zipSessionFolder(sessionDir) {
    return new Promise((resolve, reject) => {
        const outputPath = `${sessionDir}.zip`;
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(outputPath));
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(sessionDir, false);
        archive.finalize();
    });
}

/**
 * Send credentials file to user's DM
 */
async function sendCredsToUser(sock, phoneNumber, sessionDir) {
    try {
        const zipPath = await zipSessionFolder(sessionDir);
        const userJid = `${phoneNumber}@s.whatsapp.net`;

        // Send message with creds file
        await sock.sendMessage(userJid, {
            document: fs.readFileSync(zipPath),
            fileName: `creds_${phoneNumber}.zip`,
            mimetype: 'application/zip',
            caption: `✅ *WhatsApp Session Connected!*\n\n📁 Your credentials file (creds.json and session files)\n🔐 Keep this file safe and private\n⚠️ Do not share with anyone\n\n*Important Notes:*\n- This file contains your session data\n- You can use it to restore your connection\n- Store it securely\n\n✨ Connection successful!`
        });

        // Clean up zip file
        fs.unlinkSync(zipPath);

        console.log(`✅ Credentials sent to ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to send credentials:', error.message);
        return false;
    }
}

/**
 * Setup connection handlers
 */
function setupConnectionHandlers(conn, normalizedNumber, saveCreds, sessionDir, pairingCodeCallback) {
    let credsSent = false;
    let pairingCodeRequested = false;

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Request pairing code when connection is ready
        if ((connection === 'connecting' || qr) && !pairingCodeRequested && !conn.authState.creds.registered) {
            pairingCodeRequested = true;
            try {
                console.log(`\n🔄 Requesting pairing code for ${normalizedNumber}...\n`);
                const code = await conn.requestPairingCode(normalizedNumber);
                
                console.log('╔════════════════════════════╗');
                console.log('║   🔐 PAIRING CODE         ║');
                console.log('╠════════════════════════════╣');
                console.log(`║      ${code.padEnd(20)} ║`);
                console.log('╚════════════════════════════╝\n');

                // Notify via callback
                if (pairingCodeCallback) {
                    pairingCodeCallback(code);
                }
            } catch (error) {
                console.error('❌ Failed to request pairing code:', error.message);
                if (pairingCodeCallback) {
                    pairingCodeCallback(null, error);
                }
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown error';

            console.log(`\n🔌 [${normalizedNumber}] Disconnected: ${errorMsg}`);
            console.log(`📊 Status Code: ${statusCode}\n`);

            // Clean up on certain disconnect reasons
            if (statusCode === DisconnectReason.loggedOut || 
                statusCode === DisconnectReason.forbidden ||
                statusCode === DisconnectReason.connectionReplaced) {

                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    console.log(`🗑️ Deleted session for: ${normalizedNumber}`);
                }
                activeConnections.delete(normalizedNumber);
            }
        } else if (connection === 'open') {
            console.log(`\n✅ [${normalizedNumber}] Connected to WhatsApp!\n`);
            
            // Send creds file to user's DM (only once)
            if (!credsSent) {
                credsSent = true;
                setTimeout(async () => {
                    await sendCredsToUser(conn, normalizedNumber, sessionDir);
                }, 2000);
            }
        } else if (connection === 'connecting') {
            console.log(`🔄 [${normalizedNumber}] Connecting...`);
        }
    });

    conn.ev.on('creds.update', saveCreds);
}

/**
 * API Endpoint: Request Pairing Code
 */
app.post("/api/pair", async (req, res) => {
    let conn;
    
    try {
        const { number } = req.body;

        if (!number) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        const normalizedNumber = number.replace(/\D/g, "");

        if (normalizedNumber.length < 10) {
            return res.status(400).json({ 
                error: "Invalid phone number format. Include country code (e.g., 2348109860102)" 
            });
        }

        // Create session directory
        const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        console.log(`📁 Created session directory: ${sessionDir}`);

        // Initialize WhatsApp connection
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        conn = makeWASocket({
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version,
            browser: ["Chrome (Linux)", "", ""],
        });

        // Store connection
        activeConnections.set(normalizedNumber, { 
            conn, 
            saveCreds, 
            sessionDir,
            timestamp: Date.now()
        });

        // Setup handlers with callback to return pairing code
        let pairingCodeResolve;
        const pairingCodePromise = new Promise((resolve, reject) => {
            pairingCodeResolve = resolve;
            
            // Timeout after 30 seconds
            setTimeout(() => {
                reject(new Error('Pairing code request timeout'));
            }, 30000);
        });

        setupConnectionHandlers(conn, normalizedNumber, saveCreds, sessionDir, (code, error) => {
            if (error) {
                pairingCodeResolve({ error: error.message });
            } else {
                pairingCodeResolve({ code });
            }
        });

        // Wait for pairing code
        const result = await pairingCodePromise;

        if (result.error) {
            throw new Error(result.error);
        }

        console.log(`✅ Pairing code generated: ${result.code}`);

        // Return response
        res.json({ 
            success: true, 
            pairingCode: result.code,
            message: "Pairing code generated successfully. Enter it in WhatsApp within 60 seconds.",
            phoneNumber: normalizedNumber,
            expiresIn: 60,
            instructions: [
                "Open WhatsApp on your phone",
                "Go to Settings > Linked Devices",
                "Tap 'Link a Device'",
                "Tap 'Link with phone number instead'",
                `Enter code: ${result.code}`,
                "Your credentials will be sent to your WhatsApp DM once connected"
            ]
        });

    } catch (error) {
        console.error("❌ Error generating pairing code:", error);

        // Clean up on failure
        if (conn) {
            try {
                const normalizedNumber = req.body.number?.replace(/\D/g, "");
                if (normalizedNumber) {
                    const sessionDir = path.join(__dirname, "sessions", normalizedNumber);

                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }

                    if (conn.ws) {
                        conn.ws.close();
                    }
                    activeConnections.delete(normalizedNumber);
                }
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError.message);
            }
        }

        res.status(500).json({ 
            error: "Failed to generate pairing code",
            details: error.message,
            suggestion: "Please try again with a valid phone number including country code"
        });
    }
});

/**
 * API Endpoint: Check connection status
 */
app.get("/api/status/:number", (req, res) => {
    const normalizedNumber = req.params.number.replace(/\D/g, "");
    const connection = activeConnections.get(normalizedNumber);

    if (!connection) {
        return res.json({ 
            connected: false,
            message: "No active connection found"
        });
    }

    const isOpen = connection.conn.ws?.readyState === 1;
    
    res.json({ 
        connected: isOpen,
        state: isOpen ? 'open' : 'closed',
        timestamp: connection.timestamp,
        uptime: Date.now() - connection.timestamp
    });
});

/**
 * API Endpoint: Download credentials
 */
app.get("/api/download-creds/:number", async (req, res) => {
    const normalizedNumber = req.params.number.replace(/\D/g, "");
    const connection = activeConnections.get(normalizedNumber);

    if (!connection) {
        return res.status(404).json({ error: "Session not found" });
    }

    try {
        const zipPath = await zipSessionFolder(connection.sessionDir);
        res.download(zipPath, `creds_${normalizedNumber}.zip`, (err) => {
            if (!err) {
                fs.unlinkSync(zipPath);
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API Endpoint: Disconnect session
 */
app.delete("/api/disconnect/:number", async (req, res) => {
    const normalizedNumber = req.params.number.replace(/\D/g, "");
    const connection = activeConnections.get(normalizedNumber);

    if (!connection) {
        return res.json({ message: "No active connection found" });
    }

    try {
        await connection.conn.logout();
        connection.conn.ws?.close();
        activeConnections.delete(normalizedNumber);

        if (fs.existsSync(connection.sessionDir)) {
            fs.rmSync(connection.sessionDir, { recursive: true, force: true });
        }

        res.json({ 
            success: true,
            message: "Disconnected successfully" 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve HTML frontend
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Cleanup on server shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    activeConnections.forEach((connection, number) => {
        try {
            connection.conn.ws?.close();
        } catch (e) {}
    });
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 WhatsApp Pairing Code Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`🌐 Ready to generate pairing codes!\n`);
});