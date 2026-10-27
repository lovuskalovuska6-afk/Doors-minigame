const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

const players = new Map();
const rooms = new Map();
const PORT = process.env.PORT || 3000;

const id = () => crypto.randomBytes(5).toString("hex");
const number = (v, fallback = 0) =>
  Number.isFinite(v) ? Math.max(-10000, Math.min(10000, v)) : fallback;

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      door: 0,
      seed: Math.floor(Math.random() * 1e9),
      event: null,
      eventUntil: 0,
      doors: {},
      items: {},
      objectives: {}
    });
  }
  return rooms.get(code);
}

function stateFor(code) {
  const room = getRoom(code);

  return {
    code,
    door: room.door,
    seed: room.seed,
    event: room.event,
    eventUntil: room.eventUntil,
    doors: room.doors,
    items: room.items,
    objectives: room.objectives,
    players: [...players.values()]
      .filter(p => p.room === code)
      .map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        door: p.door,
        health: p.health,
        alive: p.health > 0,
        hide: p.hide,
        items: p.items
      }))
  };
}

function broadcast(code) {
  const message = JSON.stringify({
    type: "state",
    state: stateFor(code)
  });

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.player?.room === code
    ) {
      client.send(message);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function event(room, name, duration = 5000) {
  room.event = name;
  room.eventUntil = Date.now() + duration;
}

wss.on("connection", ws => {
  ws.player = null;
  send(ws, { type: "hello" });

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.room || "HALL")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 8) || "HALL";

      if (ws.player) {
        players.delete(ws.player.id);
      }

      const p = {
        id: id(),
        name: String(msg.name || "Player").slice(0, 16),
        room: code,
        x: 0,
        z: 5,
        yaw: 0,
        door: 0,
        health: 100,
        hide: false,
        items: []
      };

      ws.player = p;
      players.set(p.id, p);

      send(ws, { type: "joined", id: p.id, room: code });
      broadcast(code);
      return;
    }

    const p = ws.player;
    if (!p) return;

    const room = getRoom(p.room);

    if (msg.type === "move") {
      p.x = number(msg.x);
      p.z = number(msg.z);
      p.yaw = number(msg.yaw);
      p.door = Math.max(0, Math.floor(number(msg.door)));
      p.hide = !!msg.hide;

      const others = [...players.values()].filter(
        other => other.room === p.room &&
                 other.id !== p.id &&
                 other.health > 0
      );

      const leader = others.sort((a, b) => b.door - a.door)[0];

      // Glitch: игрок выпал за пределы карты.
      if (p.z < -500 || p.z > 500 ||
          Math.abs(p.x) > 45 || msg.y < -4) {
        p.x = 0;
        p.z = 5;
        p.hide = false;
        send(ws, { type: "glitch", reason: "fall" });
      }

      // Glitch: игрок отстал на пять дверей.
      if (leader && leader.door - p.door >= 5) {
        p.door = leader.door;
        p.x = 0;
        p.z = 5;
        p.hide = false;
        send(ws, { type: "glitch", reason: "behind" });
      }

      broadcast(p.room);
      return;
    }

    if (msg.type === "door") {
      const next = Math.max(
        room.door,
        Math.min(100, Math.floor(number(msg.door, room.door + 1)))
      );

      room.door = next;
      room.doors[next] = { open: true };

      if (next === 20 || next === 45) {
        event(room, "seek-warning", 3500);
      } else if (next === 21) {
        event(room, "seek-chase-1", 22000);
      } else if (next === 46) {
        event(room, "seek-chase-2", 22000);
      } else if (next === 50) {
        event(room, "figure-library", 30000);
      } else if (next === 100) {
        event(room, "figure-finale", 30000);
      } else if ([10, 30, 60, 80].includes(next)) {
        event(room, "eyes", 7000);
      }

      if (next > 0 && next % 7 === 0 && !room.items[next]) {
        const kinds = [
          "battery", "coin", "bandage",
          "vitamins", "lighter", "lockpick", "crucifix"
        ];

        room.items[next] = {
          kind: kinds[Math.floor(Math.random() * kinds.length)],
          taken: false
        };
      }

      broadcast(p.room);
      return;
    }

    if (msg.type === "item") {
      const item = room.items[Math.floor(number(msg.door, p.door))];

      if (item && !item.taken) {
        item.taken = true;
        if (!p.items.includes(item.kind)) p.items.push(item.kind);
        send(ws, { type: "item", kind: item.kind });
        broadcast(p.room);
      }
      return;
    }

    if (msg.type === "eyes-hit") {
      p.health = Math.max(0, p.health - 15);
      send(ws, { type: "damage", health: p.health });
      broadcast(p.room);
      return;
    }

    if (msg.type === "mini-action") {
      const key = String(msg.event || room.event || "mini");
      room.objectives[key] = (room.objectives[key] || 0) + 1;

      if (room.objectives[key] >= 6) {
        event(room, "mini-complete", 3000);
      }

      send(ws, {
        type: "objective",
        event: key,
        count: room.objectives[key]
      });

      broadcast(p.room);
    }
  });

  ws.on("close", () => {
    if (ws.player) {
      const code = ws.player.room;
      players.delete(ws.player.id);
      broadcast(code);
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.event && Date.now() > room.eventUntil) {
      room.event = null;
      broadcast(code);
    }
  }
}, 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("HALLS game started on port " + PORT);
});
