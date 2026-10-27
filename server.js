const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data, except) {
  for (const player of room.players.values()) {
    if (player.ws !== except) send(player.ws, data);
  }
}

function roomState(room) {
  return {
    type: "state",
    players: [...room.players.values()].map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      health: p.health,
      door: p.door
    })),
    door: room.door,
    events: room.events
  };
}

wss.on("connection", ws => {
  const player = {
    ws,
    id: crypto.randomUUID(),
    roomCode: null,
    x: 0,
    y: 1.7,
    z: 0,
    yaw: Math.PI,
    health: 100,
    door: 1,
    lastMove: 0
  };

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      let code = String(msg.code || "").trim().toUpperCase();

      if (!code || code === "NEW") code = makeCode();

      let room = rooms.get(code);

      if (!room) {
        room = {
          code,
          door: 1,
          players: new Map(),
          events: [],
          openedDoors: new Set()
        };
        rooms.set(code, room);
      }

      if (room.players.size >= 2) {
        send(ws, { type: "error", message: "Комната уже заполнена." });
        return;
      }

      player.roomCode = code;
      player.x = room.players.size ? 1.2 : 0;
      player.z = 0;
      player.door = room.door;
      room.players.set(player.id, player);

      send(ws, {
        type: "joined",
        id: player.id,
        code,
        door: room.door,
        players: [...room.players.values()].map(p => ({
          id: p.id,
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: p.yaw,
          health: p.health,
          door: p.door
        }))
      });

      broadcast(room, {
        type: "playerJoined",
        id: player.id
      }, ws);

      return;
    }

    const room = rooms.get(player.roomCode);
    if (!room || !room.players.has(player.id)) return;

    if (msg.type === "move") {
      const now = Date.now();
      if (now - player.lastMove < 25) return;
      player.lastMove = now;

      player.x = Number(msg.x) || 0;
      player.y = Number(msg.y) || 1.7;
      player.z = Number(msg.z) || 0;
      player.yaw = Number(msg.yaw) || 0;
      player.door = Math.max(1, Math.min(100, Number(msg.door) || 1));

      // Восстановление только при явном падении за пределы игрового мира.
      if (player.y < -5 || Math.abs(player.x) > 80 ||
          Math.abs(player.z) > 300) {
        player.x = 0;
        player.y = 1.7;
        player.z = 0;
        player.health = Math.max(1, player.health - 10);

        send(ws, {
          type: "recovered",
          health: player.health,
          message: "Искажение пространства вернуло тебя в безопасное место."
        });
      }

      broadcast(room, {
        type: "playerMove",
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        health: player.health,
        door: player.door
      }, ws);

      return;
    }

    if (msg.type === "openDoor") {
      const number = Math.max(1, Math.min(100, Number(msg.door) || room.door));

      // Комната продвигается только на следующую дверь.
      if (number > room.door && number <= room.door + 1) {
        room.door = number;
      }

      room.openedDoors.add(number);

      broadcast(room, {
        type: "doorOpened",
        door: number,
        by: player.id
      });

      return;
    }

    if (msg.type === "event") {
      const allowed = ["rush", "eyes", "seek", "figure", "screech", "halt"];
      if (!allowed.includes(msg.event)) return;

      const event = {
        id: crypto.randomUUID(),
        event: msg.event,
        door: room.door,
        time: Date.now()
      };

      room.events.push(event);
      if (room.events.length > 20) room.events.shift();

      broadcast(room, { type: "event", ...event });
      return;
    }

    if (msg.type === "damage") {
      const amount = Math.max(0, Math.min(50, Number(msg.amount) || 0));
      player.health = Math.max(0, player.health - amount);

      send(ws, {
        type: "health",
        health: player.health
      });

      broadcast(room, {
        type: "playerHealth",
        id: player.id,
        health: player.health
      }, ws);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(player.roomCode);
    if (!room) return;

    room.players.delete(player.id);

    broadcast(room, {
      type: "playerLeft",
      id: player.id
    });

    if (room.players.size === 0) rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`DOORS Horror server listening on port ${PORT}`);
});
