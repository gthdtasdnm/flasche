// FLASCHENDREHEN – Deno-Server: statische Dateien + WebSocket + Rundenlogik.
// Keine Abhaengigkeiten, kein Build-Schritt. `deno task dev` oder direkt:
//   deno run --allow-net --allow-read --allow-env --allow-sys server.js
//
// Raum, Host, Bereit, Karenzzeit und Bremse sind Zeile fuer Zeile wie in „Ich
// hab noch nie". Eigen ist alles ab „Spielablauf".
//
// Der Kern dieses Spiels ist, dass die Flasche auf **allen** Geraeten auf
// dieselbe Person zeigt. Deshalb wuerfelt der Server das Ziel aus, friert die
// Sitzreihenfolge fuer die Runde ein und schickt den fertigen Endwinkel mit.
// Die Clients drehen nur noch dorthin – sie rechnen nichts selbst aus und
// koennen daher auch nicht auseinanderlaufen.

import { MODI, stapelFuer } from "./aufgaben.js";
import {
  absender,
  darfRaumOeffnen,
  darfVerbinden,
  raumVermerkt,
  verbindungAuf,
  verbindungZu,
} from "./bremse.js";

const PORT = Number(Deno.env.get("PORT") ?? 8072);
const HOST = Deno.env.get("HOST") ?? "0.0.0.0";

const PUBLIC = new URL("./public/", import.meta.url);

// ---------------------------------------------------------------------------
// Spielkonstanten
// ---------------------------------------------------------------------------

const MAX_PLAYERS = 10;
// Zu zweit zeigt die Flasche jedes Mal auf denselben – das ist kein Drehen
// mehr, sondern eine Ansage.
const MIN_PLAYERS = 3;

const ROOM_IDLE_MS = 5 * 60_000;
const SEAT_GRACE_MS = 60_000;

const RUNDEN_OPTIONEN = [8, 12, 20, 0]; // 0 = ohne festes Ende

/** Wie lange die Flasche dreht. Muss zur CSS-Dauer im Client passen. */
const DREH_MS = 3400;

/** Volle Umdrehungen vor dem Ziel – nur fuer die Optik. */
const UMDREHUNGEN_MIN = 3;
const UMDREHUNGEN_MAX = 6;

// ---------------------------------------------------------------------------
// Raeume
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();

const browsing = new Set();

function newCode() {
  for (let i = 0; i < 500; i++) {
    let c = "";
    for (let k = 0; k < 4; k++) {
      c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(c)) return c;
  }
  return "R" + Date.now().toString(36).slice(-3).toUpperCase();
}

const token = () => crypto.randomUUID();

/** Einmal anlegen, nicht bei jedem Namen neu - das Ding ist teuer. */
const ZEICHEN = new Intl.Segmenter("de", { granularity: "grapheme" });

function cleanName(raw) {
  // Steuerzeichen raus, sonst zerlegt ein Zeilenumbruch im Namen das Layout.
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // Nach *Zeichen* kuerzen, nicht nach Code-Einheiten. `s.slice(0, 12)` zaehlt
  // UTF-16-Einheiten, und ein Emoji besteht aus zweien: abgeschnitten wurde
  // mitten im Zeichen, und im Raum stand ein Ersatzzeichen. Zweite Grenze bei
  // 48 Code-Einheiten gegen gestapelte Kombinationszeichen - abgebrochen wird
  // zwischen zwei Zeichen, nie mittendrin. Gleiche Fassung wie in raum.js.
  let kurz = "";
  for (const z of [...ZEICHEN.segment(s)].slice(0, 12)) {
    if (kurz.length + z.segment.length > 48) break;
    kurz += z.segment;
  }
  return kurz || "Spieler";
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function createRoom(isPublic) {
  const room = {
    code: newCode(),
    isPublic: !!isPublic,
    phase: "lobby",
    hostId: null,
    players: new Map(),
    settings: { rounds: 12, modus: "harmlos" },
    reihenfolge: [],
    deckW: [],
    deckP: [],
    letzterDreher: null,
    rundeNr: 0,
    aktuell: null,
    timers: new Set(),
    idleTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function scheduleIdleClose(room) {
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    if (room.players.size === 0) destroyRoom(room);
  }, ROOM_IDLE_MS);
}

function cancelIdleClose(room) {
  if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
}

function clearTimers(room) {
  for (const id of room.timers) clearTimeout(id);
  room.timers.clear();
}

/** Timer, der beim naechsten Uebergang mit aufgeraeumt wird. */
function later(room, fn, ms) {
  const id = setTimeout(() => {
    room.timers.delete(id);
    fn();
  }, ms);
  room.timers.add(id);
  return id;
}

function destroyRoom(room) {
  clearTimers(room);
  cancelIdleClose(room);
  for (const p of room.players.values()) {
    if (p.dropTimer) clearTimeout(p.dropTimer);
  }
  rooms.delete(room.code);
  pushRoomList();
}

function ensureHost(room) {
  const current = room.players.get(room.hostId);
  if (current?.connected) return;
  const all = [...room.players.values()];
  const next = all.find((p) => p.connected) ?? all[0];
  room.hostId = next ? next.id : null;
}

const anwesende = (room) => [...room.players.values()].filter((p) => p.connected);

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

function send(player, msg) {
  const ws = player.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch { /* Verbindung stirbt gleich sowieso */ }
  }
}

function raw(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch { /* egal */ }
  }
}

function broadcast(room, msg) {
  for (const p of room.players.values()) send(p, msg);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    getroffen: p.getroffen,
    ready: p.ready,
    connected: p.connected,
    host: p.id === room.hostId,
  }));
}

function roomState(room) {
  return {
    t: "room",
    code: room.code,
    isPublic: room.isPublic,
    phase: room.phase,
    hostId: room.hostId,
    settings: room.settings,
    players: publicPlayers(room),
    rundeNr: room.rundeNr,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
  };
}

function pushState(room) {
  broadcast(room, roomState(room));
  if (room.isPublic) pushRoomList();
}

function roomList() {
  return [...rooms.values()]
    .map((r) => ({ room: r, count: anwesende(r).length }))
    .filter(({ room, count }) =>
      room.isPublic && room.phase === "lobby" &&
      count > 0 && room.players.size < MAX_PLAYERS
    )
    .map(({ room, count }) => ({
      code: room.code,
      host: room.players.get(room.hostId)?.name ?? "?",
      count,
      max: MAX_PLAYERS,
      modus: room.settings.modus,
    }))
    .sort((a, b) => b.count - a.count);
}

function pushRoomList() {
  const msg = { t: "rooms", rooms: roomList() };
  for (const ws of browsing) raw(ws, msg);
}

// ---------------------------------------------------------------------------
// Karten
// ---------------------------------------------------------------------------

/**
 * Zieht eine Karte. Wahrheit und Pflicht haben eigene Stapel; innerhalb einer
 * Partie wiederholt sich keine Karte, bis ihr Stapel durch ist. Deshalb zieht
 * der Server und nicht jeder Client fuer sich.
 */
function zieheKarte(room, wahl) {
  const feld = wahl === "wahrheit" ? "deckW" : "deckP";
  if (!room[feld].length) {
    const stapel = stapelFuer(room.settings.modus, wahl);
    if (!stapel) return null;
    room[feld] = shuffle(stapel);
  }
  return room[feld].pop() ?? null;
}

// ---------------------------------------------------------------------------
// Spielablauf
// ---------------------------------------------------------------------------

function startGame(room) {
  clearTimers(room);
  room.phase = "playing";
  room.rundeNr = 0;
  // Sitzordnung liegt fuer die Partie fest: sie ist der Kreis, in dem die
  // Flasche liegt. Wuerde sie sich jede Runde neu bilden, spraenge die
  // Flasche zwischen zwei Drehungen auf eine andere Person.
  room.reihenfolge = anwesende(room).map((p) => p.id);
  room.deckW = [];
  room.deckP = [];
  room.letzterDreher = null;
  for (const p of room.players.values()) {
    p.getroffen = 0;
    p.wahrheiten = 0;
    p.pflichten = 0;
    p.gedrueckt = 0;
    p.ready = false;
  }
  pushState(room);
  naechsteRunde(room);
  pushRoomList();
}

/** Der naechste Anwesende im Kreis, ausgehend von `id`. */
function naechster(room, id) {
  const drin = room.reihenfolge.filter((x) => room.players.get(x)?.connected);
  if (!drin.length) return null;
  const i = room.reihenfolge.indexOf(id);
  if (i < 0) return drin[0];
  for (let k = 1; k <= room.reihenfolge.length; k++) {
    const kandidat = room.reihenfolge[(i + k) % room.reihenfolge.length];
    if (drin.includes(kandidat)) return kandidat;
  }
  return drin[0];
}

function naechsteRunde(room) {
  clearTimers(room);
  const rounds = room.settings.rounds;
  if (rounds > 0 && room.rundeNr >= rounds) return finishGame(room);

  const kreis = room.reihenfolge.filter((x) => room.players.get(x)?.connected);
  if (kreis.length < MIN_PLAYERS) {
    // Zu wenige im Kreis – warten, bis jemand zurueckkommt.
    room.aktuell = null;
    pushState(room);
    return;
  }

  const dreherId = room.letzterDreher === null
    ? kreis[0]
    : naechster(room, room.letzterDreher);
  room.letzterDreher = dreherId;

  room.rundeNr++;
  room.aktuell = {
    dreherId,
    // Der Kreis wird fuer die Runde eingefroren: die Flasche zeigt auf eine
    // Position, und die darf sich waehrend der Drehung nicht verschieben.
    kreis,
    zielId: null,
    winkel: null,
    schritt: "bereit",
    wahl: null,
    karte: null,
    erledigt: null,
  };
  pushRunde(room);
}

/**
 * Die Flasche drehen. Ziel und Endwinkel entstehen hier – einmal, fuer alle.
 */
function drehen(room) {
  const cur = room.aktuell;
  if (!cur || cur.schritt !== "bereit") return;

  const moeglich = cur.kreis.filter((id) =>
    id !== cur.dreherId && room.players.get(id)?.connected
  );
  if (!moeglich.length) return naechsteRunde(room);

  const zielId = moeglich[Math.floor(Math.random() * moeglich.length)];
  const platz = cur.kreis.indexOf(zielId);
  const schritt = 360 / cur.kreis.length;
  const umdrehungen = UMDREHUNGEN_MIN +
    Math.floor(Math.random() * (UMDREHUNGEN_MAX - UMDREHUNGEN_MIN + 1));

  cur.zielId = zielId;
  // Der fertige Endwinkel, nicht nur die Position: so muss der Client nichts
  // ausrechnen und kann sich folglich auch nicht verrechnen.
  cur.winkel = umdrehungen * 360 + platz * schritt;
  cur.schritt = "dreht";
  pushRunde(room);

  later(room, () => {
    if (room.aktuell !== cur || cur.schritt !== "dreht") return;
    const ziel = room.players.get(zielId);
    if (ziel) ziel.getroffen++;
    // Ohne Karten ist die Runde mit der Drehung vorbei – das ist der Modus
    // „Nur drehen", bei dem die Runde selbst entscheidet, was folgt.
    cur.schritt = room.settings.modus === "nurdrehen" ? "fertig" : "wahl";
    pushRunde(room);
    pushState(room);
  }, DREH_MS);
}

function waehlen(room, player, wahl) {
  const cur = room.aktuell;
  if (!cur || cur.schritt !== "wahl") return;
  if (player.id !== cur.zielId) return;
  if (wahl !== "wahrheit" && wahl !== "pflicht") return;
  cur.wahl = wahl;
  cur.karte = zieheKarte(room, wahl);
  cur.schritt = "aufgabe";
  if (wahl === "wahrheit") player.wahrheiten++;
  else player.pflichten++;
  pushRunde(room);
  pushState(room);
}

/** Eine andere Karte derselben Art – wer nicht kann, soll nicht steckenbleiben. */
function andereKarte(room, player) {
  const cur = room.aktuell;
  if (!cur || cur.schritt !== "aufgabe" || !cur.wahl) return;
  if (player.id !== cur.zielId && player.id !== room.hostId) return;
  cur.karte = zieheKarte(room, cur.wahl);
  pushRunde(room);
}

function abschliessen(room, player, gemacht) {
  const cur = room.aktuell;
  if (!cur) return;
  if (cur.schritt !== "aufgabe" && cur.schritt !== "fertig") return;
  if (player.id !== cur.zielId && player.id !== room.hostId) return;
  // Auslassen ist ausdruecklich erlaubt und wird gezaehlt, nicht bestraft.
  // Ein Spiel, das jemanden zu einer Aufgabe zwingt, hat am Tisch nichts
  // verloren.
  if (!gemacht) {
    const ziel = room.players.get(cur.zielId);
    if (ziel) ziel.gedrueckt++;
  }
  cur.erledigt = !!gemacht;
  pushState(room);
  naechsteRunde(room);
}

/** Der Rundenzustand. Hier ist nichts geheim – alle sehen dasselbe. */
function pushRunde(room) {
  const cur = room.aktuell;
  if (!cur) return;
  const dreher = room.players.get(cur.dreherId);
  const ziel = cur.zielId ? room.players.get(cur.zielId) : null;

  broadcast(room, {
    t: "runde",
    n: room.rundeNr,
    total: room.settings.rounds,
    modus: room.settings.modus,
    // Der eingefrorene Kreis samt Namen: daraus zeichnet der Client die
    // Sitzordnung, und der Winkel bezieht sich genau auf diese Reihenfolge.
    kreis: cur.kreis.map((id) => ({
      id,
      name: room.players.get(id)?.name ?? "?",
      da: !!room.players.get(id)?.connected,
    })),
    dreherId: cur.dreherId,
    dreherName: dreher?.name ?? "?",
    zielId: cur.zielId,
    zielName: ziel?.name ?? null,
    winkel: cur.winkel,
    drehMs: DREH_MS,
    schritt: cur.schritt,
    wahl: cur.wahl,
    karte: cur.karte,
  });
}

function finishGame(room) {
  clearTimers(room);
  room.phase = "final";
  const gespielt = room.aktuell && room.aktuell.schritt === "bereit"
    ? room.rundeNr - 1
    : room.rundeNr;
  room.aktuell = null;
  const tabelle = [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      getroffen: p.getroffen,
      wahrheiten: p.wahrheiten,
      pflichten: p.pflichten,
      gedrueckt: p.gedrueckt,
    }))
    .sort((a, b) => b.getroffen - a.getroffen);
  for (const p of room.players.values()) p.ready = false;
  broadcast(room, { t: "final", tabelle, runden: Math.max(gespielt, 0) });
  pushState(room);
  pushRoomList();
}

function backToLobby(room) {
  clearTimers(room);
  room.phase = "lobby";
  room.aktuell = null;
  room.rundeNr = 0;
  room.reihenfolge = [];
  room.letzterDreher = null;
  for (const p of room.players.values()) {
    p.ready = false;
    p.getroffen = 0;
    p.wahrheiten = 0;
    p.pflichten = 0;
    p.gedrueckt = 0;
  }
  pushState(room);
}

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

function attach(ws, room, player) {
  browsing.delete(ws);
  cancelIdleClose(room);
  if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }
  ws._room = room;
  ws._player = player;
  player.ws = ws;
  player.connected = true;
  ensureHost(room);
  send(player, {
    t: "joined",
    you: player.id,
    token: player.token,
    code: room.code,
  });
  send(player, roomState(room));
  if (room.phase === "playing" && room.aktuell) pushRunde(room);
}

function makePlayer(name, ready) {
  return {
    id: token(),
    token: token(),
    name: cleanName(name),
    ws: null,
    dropTimer: null,
    getroffen: 0,
    wahrheiten: 0,
    pflichten: 0,
    gedrueckt: 0,
    ready,
    connected: true,
  };
}

function handle(ws, msg) {
  const room = ws._room;
  const player = ws._player;

  if (msg.t === "ping") {
    raw(ws, { t: "pong", c: msg.c, s: Date.now() });
    return;
  }

  if (msg.t === "browse") {
    if (!ws._room) {
      browsing.add(ws);
      raw(ws, { t: "rooms", rooms: roomList() });
    }
    return;
  }

  if (msg.t === "create") {
    if (room) return;
    if (!darfRaumOeffnen(ws._ip)) {
      return raw(ws, { t: "error", msg: "Zu viele Räume in kurzer Zeit. Warte kurz." });
    }
    raumVermerkt(ws._ip);
    const r = createRoom(msg.isPublic);
    if (MODI.includes(msg.modus)) r.settings.modus = msg.modus;
    const p = makePlayer(msg.name, true);
    r.hostId = p.id;
    r.players.set(p.id, p);
    attach(ws, r, p);
    pushState(r);
    pushRoomList();
    return;
  }

  if (msg.t === "join") {
    if (room) return;
    const r = rooms.get(String(msg.code ?? "").toUpperCase().trim());
    if (!r) return raw(ws, { t: "error", msg: "Diesen Raum gibt es nicht" });

    if (msg.token) {
      const back = [...r.players.values()].find((p) => p.token === msg.token);
      if (back) {
        if (back.ws && back.ws !== ws && back.ws.readyState === WebSocket.OPEN) {
          try { back.ws.close(4001, "woanders geöffnet"); } catch { /* egal */ }
        }
        attach(ws, r, back);
        pushState(r);
        return;
      }
    }

    if (r.players.size >= MAX_PLAYERS) {
      return raw(ws, { t: "error", msg: `Der Raum ist voll (${MAX_PLAYERS} Spieler)` });
    }
    if (r.phase !== "lobby") {
      return raw(ws, { t: "error", msg: "Die Runde läuft schon" });
    }
    const p = makePlayer(msg.name, false);
    r.players.set(p.id, p);
    attach(ws, r, p);
    pushState(r);
    return;
  }

  if (!room || !player) return;
  room.lastActivity = Date.now();

  switch (msg.t) {
    case "name":
      player.name = cleanName(msg.name);
      pushState(room);
      if (room.aktuell) pushRunde(room);
      break;

    case "ready":
      player.ready = !!msg.value;
      pushState(room);
      break;

    case "settings": {
      if (player.id !== room.hostId || room.phase !== "lobby") break;
      if (RUNDEN_OPTIONEN.includes(msg.rounds)) room.settings.rounds = msg.rounds;
      if (MODI.includes(msg.modus)) room.settings.modus = msg.modus;
      if (typeof msg.isPublic === "boolean") room.isPublic = msg.isPublic;
      pushState(room);
      pushRoomList();
      break;
    }

    case "start": {
      if (player.id !== room.hostId || room.phase !== "lobby") break;
      const da = anwesende(room);
      if (da.length < MIN_PLAYERS) break;
      if (!da.every((p) => p.ready || p.id === room.hostId)) break;
      startGame(room);
      break;
    }

    case "drehen": {
      const cur = room.aktuell;
      if (!cur || cur.schritt !== "bereit") break;
      // Drehen darf, wer dran ist – und der Host, falls der Dreher hängt.
      if (player.id !== cur.dreherId && player.id !== room.hostId) break;
      drehen(room);
      break;
    }

    case "wahl":
      waehlen(room, player, msg.wahl);
      break;

    case "andere":
      andereKarte(room, player);
      break;

    case "fertig":
      abschliessen(room, player, true);
      break;

    case "auslassen":
      abschliessen(room, player, false);
      break;

    // Der Dreher ist weg oder will nicht – Runde neu vergeben, ohne zu zaehlen.
    case "ueberspringen": {
      const cur = room.aktuell;
      if (!cur) break;
      const dreher = room.players.get(cur.dreherId);
      const darf = player.id === cur.dreherId ||
        (player.id === room.hostId && !dreher?.connected);
      if (!darf) break;
      room.rundeNr--;
      naechsteRunde(room);
      break;
    }

    case "ende":
      if (player.id !== room.hostId || room.phase !== "playing") break;
      finishGame(room);
      break;

    case "again":
      if (player.id !== room.hostId || room.phase !== "final") break;
      backToLobby(room);
      break;

    case "leave":
      dropPlayer(ws, { immediate: true });
      break;
  }
}

function dropPlayer(ws, { immediate = false } = {}) {
  const room = ws._room;
  const player = ws._player;
  browsing.delete(ws);
  if (!room || !player) return;
  ws._room = null;
  ws._player = null;

  player.connected = false;
  player.ws = null;
  player.ready = false;

  if (immediate || room.phase === "lobby") {
    releaseSeat(room, player.id);
    return;
  }

  if (player.dropTimer) clearTimeout(player.dropTimer);
  player.dropTimer = setTimeout(() => releaseSeat(room, player.id), SEAT_GRACE_MS);

  ensureHost(room);
  // Haengt die Runde an dieser Person, laeuft sie sonst ins Leere. Waehrend
  // die Flasche dreht, wird nichts angefasst – der Timer loest das gleich
  // ohnehin auf, und ein Abbruch mitten in der Drehung saehe aus wie ein
  // Fehler.
  const cur = room.aktuell;
  if (room.phase === "playing" && cur && cur.schritt !== "dreht") {
    const haengt = cur.schritt === "bereit"
      ? cur.dreherId === player.id
      : cur.zielId === player.id;
    if (haengt) {
      room.rundeNr--;
      naechsteRunde(room);
    }
  }
  pushState(room);
  if (room.aktuell) pushRunde(room);
  pushRoomList();
}

function releaseSeat(room, id) {
  const player = room.players.get(id);
  if (!player) return;
  if (player.dropTimer) { clearTimeout(player.dropTimer); player.dropTimer = null; }

  const cur = room.aktuell;
  const warBeteiligt = cur && (cur.dreherId === id || cur.zielId === id);
  room.players.delete(id);
  room.reihenfolge = room.reihenfolge.filter((x) => x !== id);
  ensureHost(room);

  if (room.players.size === 0) {
    backToLobby(room);
    scheduleIdleClose(room);
    pushRoomList();
    return;
  }

  if (room.phase === "playing") {
    if (warBeteiligt) {
      room.rundeNr--;
      naechsteRunde(room);
    } else if (room.aktuell) {
      // Der Kreis dieser Runde bleibt stehen; die Person wird darin nur als
      // abwesend gezeigt. Ihn jetzt zu aendern wuerde die Flasche mitten in
      // der Runde auf jemand anderen zeigen lassen.
      pushRunde(room);
    }
  }

  pushState(room);
  pushRoomList();
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some((seg) => seg === "..")) {
    return new Response("Nope", { status: 400 });
  }
  const url = new URL(rel, PUBLIC);
  if (!url.href.startsWith(PUBLIC.href)) {
    return new Response("Nope", { status: 400 });
  }
  try {
    const body = await Deno.readFile(url);
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Nicht gefunden", { status: 404 });
  }
}

Deno.serve({ port: PORT, hostname: HOST }, (req, info) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet", { status: 400 });
    }
    const ip = absender(req, info);
    if (!darfVerbinden(ip)) {
      return new Response("Zu viele Verbindungen", { status: 429 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket._ip = ip;
    let gezaehlt = false;
    const abmelden = () => {
      if (!gezaehlt) return;
      gezaehlt = false;
      verbindungZu(ip);
    };
    socket.onopen = () => { gezaehlt = true; verbindungAuf(ip); };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === "string") {
        try {
          handle(socket, msg);
        } catch (err) {
          console.error("Fehler beim Verarbeiten:", err);
        }
      }
    };
    socket.onclose = () => { abmelden(); dropPlayer(socket); };
    socket.onerror = () => { abmelden(); dropPlayer(socket); };
    return response;
  }

  return serveStatic(url.pathname);
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!anwesende(room).length && now - room.lastActivity > 10 * 60_000) {
      destroyRoom(room);
    }
  }
}, 60_000);

console.log(`FLASCHENDREHEN läuft auf http://${HOST}:${PORT}/`);
