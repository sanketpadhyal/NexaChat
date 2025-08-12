const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json()); // Ensures JSON is parsed properly for all routes

// Admin password 
const ADMIN_PASSWORD = "123"; // YOUR ADMIN PASS!

let chatRooms = {}; // { roomName: [ {id, user, message, time, isAdmin}, ... ] }
let activeUsers = {}; // { roomName: Set() }
let wsConnections = {}; // { username: ws }

// Utility to load messages from JSON file
function loadChat(room) {
    const file = path.join(__dirname, `${room}.json`);
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return [];
}

// Utility to save messages to JSON file
function saveChat(room, messages) {
    fs.writeFileSync(
        path.join(__dirname, `${room}.json`),
        JSON.stringify(messages, null, 2),
    );
}

// Middleware for admin authentication
function isAdmin(req, res, next) {
    console.log("Request Body:", req.body); 
    const password = req.body.adminKey; 
    if (password && password === ADMIN_PASSWORD) {
        return next(); 
    } else {
        return res
            .status(403)
            .json({ error: "Unauthorized access, invalid password" });
    }
}

// Admin verification route
app.post("/admin/verifyKey", (req, res) => {
    const { adminKey } = req.body; 
    if (!adminKey) {
        return res.status(400).json({ error: "Admin key is required" }); 
    }

    if (adminKey === ADMIN_PASSWORD) {
        return res.json({ success: true });
    } else {
        return res.status(401).json({ success: false });
    }
});

// Get active users in a room
app.get("/users/:room", (req, res) => {
    const room = req.params.room;
    console.log(`Fetching active users for room: ${room}`);
    res.json(Array.from(activeUsers[room] || []));
});

// Post a new message to a room
app.post("/chat/:room", (req, res) => {
    const room = req.params.room;
    const { user, message, isAdmin } = req.body;
    if (!user || !message) {
        return res.status(400).json({ error: "User and message required" });
    }

    const newMessage = {
        id: Date.now().toString(),
        user,
        message,
        time: Date.now(),
        isAdmin: !!isAdmin,
    };

    if (!chatRooms[room]) chatRooms[room] = [];
    chatRooms[room].push(newMessage);

    saveChat(room, chatRooms[room]);
    broadcastToRoom(room, { type: "message", data: newMessage });

    console.log(`New message posted to room ${room}: ${message}`);
    res.json({ success: true });
});

// Clear multiple chatrooms (admin)
app.delete("/admin/clearChatrooms", isAdmin, (req, res) => {
    const roomsToClear = ["General", "gaming", "travel", "study"]; // List of rooms to clear
    let clearedRooms = [];

    try {
        // Iterating over rooms to clear them
        roomsToClear.forEach((room) => {
            const roomFile = path.join(__dirname, `${room}.json`);
            console.log(`Checking if room file exists: ${roomFile}`);

            if (fs.existsSync(roomFile)) {
                console.log(`Clearing room: ${room}`);
                fs.writeFileSync(roomFile, JSON.stringify([], null, 2)); // Reset the chat room file
                clearedRooms.push(room);
                chatRooms[room] = [];
            } else {
                console.log(`Room file not found for: ${room}`);
            }
        });

        if (clearedRooms.length > 0) {
            clearedRooms.forEach((room) => {
                broadcastToRoom(room, { type: "clear_room" });
            });

            console.log("Chat rooms cleared successfully!");
            res.json({
                success: true,
                message: `Cleared rooms: ${clearedRooms.join(", ")}`,
            });
        } else {
            console.log("No rooms found to clear.");
            res.status(404).json({
                error: "No rooms to clear or rooms not found",
            });
        }
    } catch (error) {
        console.error("Error in clearing chat rooms:", error);
        res.status(500).json({
            error: "Internal Server Error: " + error.message,
        });
    }
});

// Function to broadcast to all clients in a given room
function broadcastToRoom(room, message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.room === room) {
            client.send(JSON.stringify(message));
        }
    });
}

// Start HTTP + WebSocket server
const server = app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === "join") {
                ws.room = data.room;
                ws.username = data.user;
                wsConnections[ws.username] = ws;

                if (!chatRooms[ws.room]) {
                    chatRooms[ws.room] = loadChat(ws.room);
                }
                if (!activeUsers[ws.room]) {
                    activeUsers[ws.room] = new Set();
                }

                activeUsers[ws.room].add(ws.username);

                // Send chat history
                ws.send(
                    JSON.stringify({
                        type: "history",
                        data: chatRooms[ws.room] || [],
                    }),
                );

                // Send current user list
                ws.send(
                    JSON.stringify({
                        type: "users",
                        data: Array.from(activeUsers[ws.room]),
                    }),
                );

                // Broadcast updated user list
                broadcastToRoom(ws.room, {
                    type: "users",
                    data: Array.from(activeUsers[ws.room]),
                });
            }

            if (data.type === "typing") {
                broadcastToRoom(ws.room, {
                    type: "typing",
                    user: ws.username,
                });
            }

            if (data.type === "stop_typing") {
                broadcastToRoom(ws.room, {
                    type: "stop_typing",
                    user: ws.username,
                });
            }
        } catch (err) {
            console.error("WebSocket error", err);
        }
    });

    ws.on("close", () => {
        if (ws.room && ws.username) {
            activeUsers[ws.room]?.delete(ws.username);
            delete wsConnections[ws.username];

            broadcastToRoom(ws.room, {
                type: "users",
                data: Array.from(activeUsers[ws.room] || []),
            });
        }
    });
});

// Clear specific chatroom (admin)
app.delete("/admin/clearChatrooms/:room", isAdmin, (req, res) => {
    const room = req.params.room; // Get the room name from params
    const roomFile = path.join(__dirname, `${room}.json`);

    if (!fs.existsSync(roomFile)) {
        return res.status(404).json({
            error: `${room} chatroom not found`,
        });
    }

    try {
        fs.writeFileSync(roomFile, JSON.stringify([], null, 2)); // Reset the chat room file
        chatRooms[room] = []; // Clear in-memory chat data
        broadcastToRoom(room, { type: "clear_room" });
        console.log(`Chatroom ${room} cleared.`);
        return res.json({
            success: true,
            message: `${room} chatroom cleared successfully!`,
        });
    } catch (error) {
        console.error(`Error clearing ${room} chatroom:`, error);
        return res.status(500).json({
            error: `Error clearing ${room} chatroom: ${error.message}`,
        });
    }
});

// Default route to check if the server is running
app.get("/", (req, res) => {
    res.send("NexaChat 📌 backend is running ...");
});
