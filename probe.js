// Spielt den ganzen Ablauf mit vier Clients durch: Raum, Warteraum, Drehen,
// Wahrheit, Pflicht, andere Karte, Auslassen, Modus „Nur drehen", Endstand.
//
// Der Kern der Probe ist die Einigkeit: nach einer Drehung müssen **alle**
// Clients dasselbe Ziel und denselben Winkel sehen. Zeigt die Flasche auf zwei
// Geräten auf verschiedene Leute, ist das Spiel kaputt – und genau das würde
// man am Tisch erst merken, wenn zwei Leute gleichzeitig aufstehen.
//
//   deno task dev            (in einer zweiten Sitzung)
//   deno task probe
// Gegen die Live-Fassung statt gegen den lokalen Server:
//   WS_URL=wss://inf-zeus.de/flasche/ws deno task probe

import {
  MODI,
  PFLICHT_FRECH,
  PFLICHT_HARMLOS,
  WAHRHEIT_FRECH,
  WAHRHEIT_HARMLOS,
  stapelFuer,
} from "./aufgaben.js";

const PORT = Deno.env.get("PORT") ?? "8072";
const URL_WS = Deno.env.get("WS_URL") ?? `ws://127.0.0.1:${PORT}/ws`;

function client(name) {
  const c = {
    name, ws: new WebSocket(URL_WS), you: null, room: null, runde: null,
    final: null, fehler: [],
  };
  c.ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "joined") c.you = m.you;
    if (m.t === "room") c.room = m;
    if (m.t === "runde") c.runde = m;
    if (m.t === "final") c.final = m;
    if (m.t === "error") c.fehler.push(m.msg);
  };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.offen = new Promise((res) => { c.ws.onopen = res; });
  return c;
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

async function bis(bedingung, was, ms = 8000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return;
    await warte(25);
  }
  throw new Error("Zeitüberschreitung: " + was);
}

// --- Erst die Kartenstapel, ohne Server -------------------------------------

const stapel = {
  WAHRHEIT_HARMLOS, PFLICHT_HARMLOS, WAHRHEIT_FRECH, PFLICHT_FRECH,
};
let gesamt = 0;
for (const [name, liste] of Object.entries(stapel)) {
  if (new Set(liste).size !== liste.length) throw new Error(`${name} enthält Doppelte`);
  if (liste.length < 25) throw new Error(`${name} hat nur ${liste.length} Karten`);
  for (const k of liste) {
    if (!k.endsWith("?") && !k.endsWith(".")) {
      throw new Error(`${name}: Karte ohne Satzzeichen: ${k}`);
    }
    if (k[0] !== k[0].toUpperCase()) {
      throw new Error(`${name}: Karte fängt klein an: ${k}`);
    }
  }
  gesamt += liste.length;
}
// Wahrheiten sind Fragen, Pflichten sind Anweisungen – das trennt die beiden
// Stapel im Kopf, und ein verrutschter Text fällt hier auf.
for (const k of [...WAHRHEIT_HARMLOS, ...WAHRHEIT_FRECH]) {
  if (!k.endsWith("?")) throw new Error(`Wahrheit ohne Fragezeichen: ${k}`);
}
for (const k of [...PFLICHT_HARMLOS, ...PFLICHT_FRECH]) {
  if (k.endsWith("?")) throw new Error(`Pflicht als Frage formuliert: ${k}`);
}
// Kein Alkohol, kein Koerperkontakt – das ist die ganze Begruendung dafuer,
// dass dieses Spiel ohne 18+-Abfrage auskommt.
const VERBOTEN = /\b(trink|schluck|bier|wein|shot|schnaps|kuss|küss|nackt|ausziehen)/i;
for (const [name, liste] of Object.entries(stapel)) {
  for (const k of liste) {
    if (VERBOTEN.test(k)) throw new Error(`${name}: verbotenes Thema in „${k}"`);
  }
}
if (stapelFuer("nurdrehen", "wahrheit") !== null) {
  throw new Error("Der Modus nurdrehen liefert trotzdem einen Stapel");
}
if (stapelFuer("frech", "wahrheit").length !== WAHRHEIT_HARMLOS.length + WAHRHEIT_FRECH.length) {
  throw new Error("Frech ist nicht die Summe beider Wahrheitsstapel");
}
console.log(`ok  ${gesamt} Karten, keine Doppelten, kein Alkohol, kein Körperkontakt`);
if (!MODI.includes("nurdrehen")) throw new Error("Modus nurdrehen fehlt");

// --- Jetzt der Server -------------------------------------------------------

const A = client("Anna"), B = client("Ben"), C = client("Cem"), D = client("Dana");
const alleC = [A, B, C, D];
await Promise.all(alleC.map((c) => c.offen));

A.send({ t: "create", name: "Anna", isPublic: true, modus: "harmlos" });
await bis(() => A.room, "Raum angelegt");
const code = A.room.code;
console.log("Raum:", code);

for (const [c, n] of [[B, "Ben"], [C, "Cem"], [D, "Dana"]]) c.send({ t: "join", code, name: n });
await bis(() => A.room.players.length === 4, "vier Spieler");

A.send({ t: "start" });
await warte(150);
if (A.room.phase !== "lobby") throw new Error("Start ging ohne Bereit durch");
console.log("ok  Start blockiert, solange nicht alle bereit sind");

for (const c of [B, C, D]) c.send({ t: "ready", value: true });
await bis(() => A.room.players.every((p) => p.ready || p.host), "alle bereit");
A.send({ t: "settings", rounds: 20, modus: "harmlos" });
await warte(120);
A.send({ t: "start" });
await bis(() => A.runde && A.room.phase === "playing", "Runde 1 läuft");

const von = (id) => alleC.find((c) => c.you === id);

// --- Alle sehen denselben Kreis ---------------------------------------------

{
  const kreise = alleC.map((c) => c.runde.kreis.map((p) => p.id).join(","));
  if (new Set(kreise).size !== 1) throw new Error("Die Clients sehen verschiedene Kreise");
  if (A.runde.kreis.length !== 4) throw new Error("Der Kreis hat nicht vier Plätze");
  console.log("ok  alle vier sehen denselben Kreis in derselben Reihenfolge");
}

// --- Drehen: nur der Dreher, und alle sehen dasselbe Ziel --------------------

{
  const dreherId = A.runde.dreherId;
  const fremd = alleC.find((c) => c.you !== dreherId && c.you !== A.room.hostId);
  fremd.send({ t: "drehen" });
  await warte(150);
  if (A.runde.schritt !== "bereit") throw new Error("Ein Fremder konnte drehen");
  console.log("ok  nur wer dran ist (oder der Host) dreht die Flasche");

  von(dreherId).send({ t: "drehen" });
  await bis(() => A.runde.schritt === "dreht", "Flasche dreht");

  const ziele = alleC.map((c) => c.runde.zielId);
  const winkel = alleC.map((c) => c.runde.winkel);
  if (new Set(ziele).size !== 1) throw new Error("Die Clients sehen verschiedene Ziele!");
  if (new Set(winkel).size !== 1) throw new Error("Die Clients bekommen verschiedene Winkel!");
  if (ziele[0] === dreherId) throw new Error("Die Flasche zeigt auf den Dreher selbst");
  console.log(`ok  ein Ziel, ein Winkel (${winkel[0]}°) – bei allen vier gleich`);

  // Der Winkel muss zur Position des Ziels im Kreis passen. Das ist die
  // Verabredung, an der die ganze Anzeige haengt.
  const platz = A.runde.kreis.findIndex((p) => p.id === ziele[0]);
  const schritt = 360 / A.runde.kreis.length;
  const rest = ((winkel[0] % 360) + 360) % 360;
  if (Math.abs(rest - platz * schritt) > 0.01) {
    throw new Error(`Winkel ${winkel[0]}° passt nicht zu Platz ${platz}`);
  }
  if (winkel[0] < 360 * 3) throw new Error("Zu wenige Umdrehungen für eine sichtbare Drehung");
  console.log(`ok  Winkel zeigt auf Platz ${platz} von ${A.runde.kreis.length}`);

  // Waehrend der Drehung darf niemand vorgreifen.
  von(ziele[0]).send({ t: "wahl", wahl: "wahrheit" });
  await warte(150);
  if (A.runde.schritt !== "dreht") throw new Error("Man konnte während der Drehung wählen");
  console.log("ok  während die Flasche dreht, geht nichts");

  await bis(() => A.runde.schritt === "wahl", "Drehung fertig", 8000);
  console.log("ok  nach der Drehung kommt die Wahl");
}

// --- Wahrheit ----------------------------------------------------------------

{
  const zielId = A.runde.zielId;
  const fremd = alleC.find((c) => c.you !== zielId);
  fremd.send({ t: "wahl", wahl: "pflicht" });
  await warte(150);
  if (A.runde.schritt !== "wahl") throw new Error("Ein Fremder konnte für das Ziel wählen");
  console.log("ok  nur wer getroffen wurde, wählt");

  von(zielId).send({ t: "wahl", wahl: "wahrheit" });
  await bis(() => A.runde.schritt === "aufgabe", "Karte liegt");
  if (A.runde.wahl !== "wahrheit") throw new Error("Falsche Wahl vermerkt");
  if (!A.runde.karte) throw new Error("Keine Karte gezogen");
  if (!WAHRHEIT_HARMLOS.includes(A.runde.karte)) {
    throw new Error("Die Karte stammt nicht aus dem harmlosen Wahrheitsstapel");
  }
  // Die Karte sehen alle – hier ist nichts geheim.
  if (new Set(alleC.map((c) => c.runde.karte)).size !== 1) {
    throw new Error("Nicht alle sehen dieselbe Karte");
  }
  console.log(`ok  Wahrheit gezogen, bei allen gleich: „${A.runde.karte}"`);

  const alt = A.runde.karte;
  von(zielId).send({ t: "andere" });
  await bis(() => A.runde.karte !== alt, "andere Karte");
  if (A.runde.wahl !== "wahrheit") throw new Error("Andere Karte hat die Wahl geändert");
  console.log("ok  Andere-Karte tauscht innerhalb derselben Art");

  von(zielId).send({ t: "fertig" });
  await bis(() => A.runde.n === 2, "Runde 2");
  await bis(() => A.room.players.find((p) => p.id === zielId)?.getroffen === 1, "getroffen gezählt");
  console.log("ok  Erledigt zählt und schaltet zur nächsten Runde");
}

// --- Der Dreher wechselt reihum ---------------------------------------------

{
  if (A.runde.dreherId === undefined) throw new Error("Kein Dreher in Runde 2");
  const kreis = A.runde.kreis.map((p) => p.id);
  const dreher = [];
  for (let runde = 2; runde <= 5; runde++) {
    await bis(() => A.runde.n === runde && A.runde.schritt === "bereit", `Runde ${runde}`);
    dreher.push(A.runde.dreherId);
    von(A.runde.dreherId).send({ t: "drehen" });
    await bis(() => A.runde.schritt === "wahl", `Runde ${runde} gedreht`, 9000);
    const ziel = von(A.runde.zielId);
    ziel.send({ t: "wahl", wahl: "pflicht" });
    await bis(() => A.runde.schritt === "aufgabe", "Pflichtkarte");
    if (!PFLICHT_HARMLOS.includes(A.runde.karte)) {
      throw new Error("Pflichtkarte stammt nicht aus dem harmlosen Pflichtstapel");
    }
    // Auslassen muss erlaubt sein und darf nichts kosten.
    ziel.send({ t: "auslassen" });
    await bis(() => A.runde.n === runde + 1 || A.final, "weiter");
  }
  const erwartet = dreher.map((id) => kreis.indexOf(id));
  console.log(`ok  Pflicht gezogen und ausgelassen; Dreher der Reihe nach: ${erwartet.join(" → ")}`);
  if (new Set(dreher).size < 3) throw new Error("Der Dreher wechselt nicht reihum: " + erwartet);
  console.log("ok  Auslassen ist erlaubt und beendet die Runde");
}

// --- Modus „Nur drehen" -------------------------------------------------------

for (const c of alleC) c.final = null;
A.send({ t: "ende" });
await bis(() => A.final, "Endstand 1");
A.send({ t: "again" });
await bis(() => A.room.phase === "lobby", "zurück im Warteraum");
if (A.room.players.some((p) => p.getroffen !== 0)) throw new Error("Zähler nicht zurückgesetzt");
console.log("ok  Nochmal setzt alles zurück");

for (const c of [B, C, D]) c.send({ t: "ready", value: true });
await bis(() => A.room.players.every((p) => p.ready || p.host), "wieder bereit");
A.send({ t: "settings", modus: "nurdrehen" });
await bis(() => A.room.settings.modus === "nurdrehen", "Modus umgestellt");
A.send({ t: "start" });
await bis(() => A.runde && A.room.phase === "playing", "neue Partie");

{
  von(A.runde.dreherId).send({ t: "drehen" });
  await bis(() => A.runde.schritt === "fertig", "ohne Karten direkt fertig", 9000);
  if (A.runde.karte) throw new Error("Im Modus nurdrehen kam trotzdem eine Karte");
  if (A.runde.wahl) throw new Error("Im Modus nurdrehen wurde trotzdem gewählt");
  console.log("ok  Nur-drehen: nach der Drehung ist die Runde vorbei, ohne Karte");
  von(A.runde.zielId).send({ t: "fertig" });
  await bis(() => A.runde.n === 2, "nächste Runde");
}

// --- Endstand ----------------------------------------------------------------

for (const c of alleC) c.final = null;
A.send({ t: "ende" });
await bis(() => A.final, "Endstand");
// Die zweite Partie lief im Modus „Nur drehen": zwei Runden, keine Karten.
if (A.final.tabelle.some((p) => p.wahrheiten || p.pflichten)) {
  throw new Error("Im Modus nurdrehen wurden Wahrheiten oder Pflichten gezählt");
}
const getroffen = A.final.tabelle.reduce((s, p) => s + p.getroffen, 0);
if (getroffen !== 1) {
  throw new Error(`Genau eine abgeschlossene Drehung erwartet, gezählt: ${getroffen}`);
}
console.log("ok  der zweite Endstand gehört zur zweiten Partie, nicht zur ersten");
console.log(`\nEndstand nach ${A.final.runden} Runden:`);
for (const p of A.final.tabelle) {
  console.log(`  ${p.name.padEnd(6)} ${p.getroffen}× getroffen,` +
    ` ${p.wahrheiten}× Wahrheit, ${p.pflichten}× Pflicht, ${p.gedrueckt}× ausgelassen`);
}
for (let i = 1; i < A.final.tabelle.length; i++) {
  if (A.final.tabelle[i - 1].getroffen < A.final.tabelle[i].getroffen) {
    throw new Error("Der Endstand ist nicht absteigend sortiert");
  }
}
console.log("ok  Endstand sortiert");

if (alleC.some((c) => c.fehler.length)) {
  throw new Error("Fehlermeldungen: " + JSON.stringify(alleC.map((c) => c.fehler)));
}
console.log("\nALLES GRÜN");
Deno.exit(0);
