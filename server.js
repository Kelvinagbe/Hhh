// server.js
const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const P = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active connections
const activeConnections = new Map();
const pairingCodes = new Map();

/**
 * Request pairing code from WhatsApp
 */
async function requestPairingCode(sock, phoneNumber) {
    try {
        console.log(`\n🔄 Requesting pairing code for ${phoneNumber}...\n`);
        
        const code = await sock.requestPairingCode(phoneNumber);
        
        console.log('╔════════════════════════════╗');
        console.log('║   🔐 PAIRING CODE         ║');
        console.log('╠════════════════════════════╣');
        console.log(`║      ${code.padEnd(20)} ║`);
        console.log('╚════════════════════════════╝\n');
        
        return code;
    } catch (error) {
        console.error('❌ Failed to request pairing code:', error.message);
        throw error;
    }
}

/**
 * Setup connection handlers
 */
function setupConnectionHandlers(conn, normalizedNumber, saveCreds) {
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown error';
            
            console.log(`\n🔌 [${normalizedNumber}] Disconnected: ${errorMsg}`);
            console.log(`📊 Status Code: ${statusCode}\n`);
            
            // Clean up on certain disconnect reasons
            if (statusCode === DisconnectReason.loggedOut || 
                statusCode === DisconnectReason.forbidden ||
                statusCode === DisconnectReason.connectionReplaced) {
                
                const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    console.log(`🗑️ Deleted session for: ${normalizedNumber}`);
                }
                activeConnections.delete(normalizedNumber);
            }
        } else if (connection === 'open') {
            console.log(`\n✅ [${normalizedNumber}] Connected to WhatsApp!\n`);
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
            connectTimeoutMs: 60000,
        });

        // Store connection
        activeConnections.set(normalizedNumber, { conn, saveCreds });

        // Setup handlers
        setupConnectionHandlers(conn, normalizedNumber, saveCreds);

        // Wait for connection to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Request pairing code
        const pairingCode = await requestPairingCode(conn, normalizedNumber);
        
        // Store pairing code with timestamp
        pairingCodes.set(normalizedNumber, { 
            code: pairingCode, 
            timestamp: Date.now() 
        });

        // Return response
        res.json({ 
            success: true, 
            pairingCode,
            message: "Pairing code generated successfully. Valid for 60 seconds.",
            expiresIn: 60
        });

    } catch (error) {
        console.error("Error generating pairing code:", error);
        
        // Clean up on failure
        if (conn && number) {
            try {
                const normalizedNumber = number.replace(/\D/g, "");
                const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
                
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                
                conn.ws.close();
                activeConnections.delete(normalizedNumber);
            } catch (e) {}
        }
        
        res.status(500).json({ 
            error: "Failed to generate pairing code",
            details: error.message 
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
        return res.json({ connected: false });
    }
    
    res.json({ 
        connected: true,
        state: connection.conn.ws.readyState === 1 ? 'open' : 'closed'
    });
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
        connection.conn.ws.close();
        activeConnections.delete(normalizedNumber);
        
        const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        
        res.json({ message: "Disconnected successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve HTML frontend
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 WhatsApp Pairing Code Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📡 Server running on: http://localhost:${PORT}`);
    console.log(`🌐 Ready to generate pairing codes!\n`);
});
