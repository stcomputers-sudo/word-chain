const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the static HTML file
app.use(express.static(path.join(__dirname)));

const rooms = {};
const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Helper: Fetch with timeout for dictionary API
const fetchWithTimeout = (url, ms) => Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
]);

async function validateWord(word) {
    try {
        // Using Datamuse API to check if the word exists in the English dictionary
        const response = await fetchWithTimeout(`https://api.datamuse.com/words?sp=${word}&max=1`, 3000);
        const data = await response.json();
        return data.length > 0 && data[0].word.toLowerCase() === word.toLowerCase();
    } catch (error) {
        console.error('Dictionary API Error:', error);
        return true; // Fail open to keep game moving if API is down
    }
}

function startTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    clearInterval(room.timerId);
    room.timeLeft = 20;
    
    io.to(roomId).emit('timerUpdate', { timeLeft: room.timeLeft, currentTurnId: room.currentTurnId });
    
    room.timerId = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timerUpdate', { timeLeft: room.timeLeft, currentTurnId: room.currentTurnId });
        
        if (room.timeLeft <= 0) {
            clearInterval(room.timerId);
            eliminatePlayer(roomId, room.currentTurnId, 'Time ran out!');
        }
    }, 1000);
}

function eliminatePlayer(roomId, playerId, reason) {
    const room = rooms[roomId];
    if (!room) return;

    const playerIndex = room.turnOrder.indexOf(playerId);
    if (playerIndex !== -1) {
        room.turnOrder.splice(playerIndex, 1);
        if (room.players[playerId]) {
            room.players[playerId].eliminated = true;
        }
        io.to(roomId).emit('playerEliminated', { playerId, reason });
    }

    if (room.turnOrder.length <= 1) {
        endGame(roomId);
    } else {
        room.currentTurnIndex = playerIndex % room.turnOrder.length;
        room.currentTurnId = room.turnOrder[room.currentTurnIndex];
        startTimer(roomId);
    }
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    clearInterval(room.timerId);
    room.state = 'finished';
    
    const winnerId = room.turnOrder[0] || null;
    io.to(roomId).emit('gameOver', { winnerId });
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    room.currentTurnId = room.turnOrder[room.currentTurnIndex];
    startTimer(roomId);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', (playerName) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            isPublic: false,
            host: socket.id,
            players: { [socket.id]: { name: playerName || 'Host', eliminated: false } },
            state: 'lobby',
            chain: [],
            lastLetter: null,
            currentTurnId: null,
            currentTurnIndex: 0,
            turnOrder: [socket.id],
            timeLeft: 20,
            timerId: null
        };
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        io.to(roomId).emit('lobbyUpdate', rooms[roomId]);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', 'Room not found.');
        if (room.state !== 'lobby') return socket.emit('errorMessage', 'Game already started.');
        if (Object.keys(room.players).length >= 8) return socket.emit('errorMessage', 'Room is full.');

        room.players[socket.id] = { name: playerName || 'Player', eliminated: false };
        room.turnOrder.push(socket.id);
        
        socket.join(roomId);
        socket.emit('roomJoined', roomId);
        io.to(roomId).emit('lobbyUpdate', room);
    });

    socket.on('worldJoin', (playerName) => {
        let availableRoom = null;
        for (const id in rooms) {
            if (rooms[id].isPublic && rooms[id].state === 'lobby' && Object.keys(rooms[id].players).length < 8) {
                availableRoom = rooms[id];
                break;
            }
        }

        if (availableRoom) {
            availableRoom.players[socket.id] = { name: playerName || 'Player', eliminated: false };
            availableRoom.turnOrder.push(socket.id);
            socket.join(availableRoom.id);
            socket.emit('roomJoined', availableRoom.id);
            io.to(availableRoom.id).emit('lobbyUpdate', availableRoom);
        } else {
            const roomId = generateRoomId();
            rooms[roomId] = {
                id: roomId,
                isPublic: true,
                host: socket.id,
                players: { [socket.id]: { name: playerName || 'Player', eliminated: false } },
                state: 'lobby',
                chain: [],
                lastLetter: null,
                currentTurnId: null,
                currentTurnIndex: 0,
                turnOrder: [socket.id],
                timeLeft: 20,
                timerId: null
            };
            socket.join(roomId);
            socket.emit('roomJoined', roomId);
            io.to(roomId).emit('lobbyUpdate', rooms[roomId]);
        }
    });

    socket.on('startGame', () => {
        const roomId = Object.keys(socket.rooms).find(r => r !== socket.id);
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        if (Object.keys(room.players).length < 2) return socket.emit('errorMessage', 'Need at least 2 players to start.');

        room.state = 'playing';
        room.currentTurnId = room.turnOrder[0];
        io.to(roomId).emit('gameStart', room);
        startTimer(roomId);
    });

    socket.on('submitWord', async (word) => {
        const roomId = Object.keys(socket.rooms).find(r => r !== socket.id);
        const room = rooms[roomId];
        if (!room || room.state !== 'playing' || room.currentTurnId !== socket.id) return;

        const cleanWord = word.toLowerCase().trim();
        if (!/^[a-z]+$/.test(cleanWord)) return socket.emit('invalidWord', 'Only letters allowed.');
        if (cleanWord.length < 2) return socket.emit('invalidWord', 'Word too short.');
        if (room.chain.includes(cleanWord)) return socket.emit('invalidWord', 'Word already used.');
        if (room.lastLetter && cleanWord[0] !== room.lastLetter) return socket.emit('invalidWord', `Must start with '${room.lastLetter.toUpperCase()}'.`);

        const isValid = await validateWord(cleanWord);
        if (!isValid) return socket.emit('invalidWord', 'Not a valid English word.');

        room.chain.push(cleanWord);
        room.lastLetter = cleanWord[cleanWord.length - 1];
        
        io.to(roomId).emit('wordAccepted', { word: cleanWord, playerId: socket.id, lastLetter: room.lastLetter });
        nextTurn(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = Object.keys(socket.rooms).find(r => r !== socket.id);
        const room = rooms[roomId];
        if (!room) return;

        delete room.players[socket.id];
        const idx = room.turnOrder.indexOf(socket.id);
        if (idx !== -1) room.turnOrder.splice(idx, 1);

        if (room.turnOrder.length === 0) {
            clearInterval(room.timerId);
            delete rooms[roomId];
            return;
        }

        if (room.host === socket.id) {
            room.host = room.turnOrder[0];
        }

        if (room.state === 'playing') {
            if (room.currentTurnId === socket.id) {
                clearInterval(room.timerId);
                room.currentTurnIndex = idx % room.turnOrder.length;
                room.currentTurnId = room.turnOrder[room.currentTurnIndex];
                startTimer(roomId);
            }
        }

        io.to(roomId).emit('lobbyUpdate', room);
        if (room.state === 'playing') io.to(roomId).emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Word Chain server running on http://localhost:${PORT}`);
});