// Client: Verbindung, Warteraum, Kreis, Flaschendrehung, Karte.
//
// Der Endwinkel der Flasche kommt fertig vom Server. Der Client rechnet ihn
// nicht nach – sonst könnten zwei Geräte auf verschiedene Leute zeigen, und
// genau das wäre das Ende des Spiels.

import { starteSprache, t, uebersetze } from "./sprache.js";
import { WOERTER } from "./texte.js";

// Vor allem, was zeichnet: der Warteraum soll gleich in der richtigen
// Sprache dastehen. Deutsch steht im HTML und in den Aufrufen hier.
starteSprache(WOERTER);

const $ = (id) => document.getElementById(id);

// Sitzplatz-Tierchen. Gleiche Liste und gleiche Ableitung wie in den anderen
// Spielen, damit dieselbe Person überall dasselbe Zeichen bekommt.
const AVATARS = ["🦊", "🐙", "🦅", "🐺", "🦁", "🐉"];
const avatarFor = (id) =>
  AVATARS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARS.length];

const MODUS_TEXT = {
  nurdrehen: "Nur drehen",
  harmlos: "Harmlos",
  frech: "Frech",
  // Uebersetzt wird beim Anzeigen (fl.modus.*) - hier steht der deutsche
  // Wortlaut, wie ueberall.
};

const state = {
  you: null,
  code: null,
  room: null,
  runde: null,
  pendingIntent: null,
  visibility: "public",
  modus: "harmlos",
  // Der zuletzt gesetzte Winkel. Die Flasche darf nie zurückspringen, sonst
  // dreht sie in der nächsten Runde rückwärts.
  winkelStand: 0,
  letzteRunde: null,
};

// ---------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------

let sock = null;
let retryIn = 500;

// Die eigene Kennung. Gleiche Regel wie in `gemeinsam/schale.js`, hier von
// Hand – dieser Client hat die Schale nicht.
//
// Bis zum 17.08.2026 lag sie im `sessionStorage` und starb mit dem Tab. Auf
// dem Handy schließt Safari Tabs von sich aus; wer zurückkam, war für den
// Server ein neuer Spieler, während sein alter Platz mit dem Hostzeichen
// stehenblieb – und niemand mehr starten konnte. Das war Bugreport 4.
//
// Jetzt `localStorage` plus Herzschlag: der Tab, dem die Kennung gehört,
// frischt sie alle vier Sekunden auf und schreibt seine Tabkennung dazu.
//
//   gleiche Tabkennung        → das sind wir selbst (Neuladen)
//   fremd, Herzschlag frisch  → ein anderer Tab spielt gerade, Finger weg
//   fremd, Herzschlag alt     → niemand da, Kennung übernehmen
//
// Ohne den mittleren Fall zögen sich zwei Tabs abwechselnd den Platz weg.
// Nach zwei Stunden verfällt der Eintrag: dann gibt es den Raum längst nicht
// mehr, und niemand will morgen früh in die Runde von gestern geworfen werden.
const SITZ_KEY = "flasche";
const HERZ_MS = 4000;
const HERZ_TOT = 12_000;
const SITZ_VERFALL = 2 * 60 * 60 * 1000;
const TAB = (() => {
  try {
    const t = sessionStorage.getItem("spiele_tab") ??
      (crypto.randomUUID?.() ?? String(Date.now()) + String(Math.random()).slice(2));
    sessionStorage.setItem("spiele_tab", t);
    return t;
  } catch {
    return "tab";
  }
})();
let herzUhr = null;

function session() {
  try {
    const s = JSON.parse(localStorage.getItem(SITZ_KEY) ?? "null");
    if (!s || !s.code || !s.token) return null;
    const alt = Date.now() - (s.herz ?? 0);
    if (alt > SITZ_VERFALL) { localStorage.removeItem(SITZ_KEY); return null; }
    if (s.tab !== TAB && alt < HERZ_TOT) return null;
    return s;
  } catch {
    return null;
  }
}

/** Token für genau diesen Raum – sonst nichts, damit kein fremder mitfährt. */
const tokenFuer = (code) => (session()?.code === code ? session().token : undefined);

function saveSession(data) {
  try {
    clearInterval(herzUhr);
    herzUhr = null;
    if (!data) { localStorage.removeItem(SITZ_KEY); return; }
    const schreibe = () => localStorage.setItem(
      SITZ_KEY,
      JSON.stringify({ ...data, tab: TAB, herz: Date.now() }),
    );
    schreibe();
    herzUhr = setInterval(schreibe, HERZ_MS);
  } catch { /* Privatmodus – dann eben ohne Wiedereinstieg */ }
}

function send(msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function connect() {
  // Muss aus dem Basispfad kommen: das Spiel läuft in Produktion unter
  // /flasche/, ein festes "/ws" landet auf der Domainwurzel.
  const url = new URL("ws", document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  sock = new WebSocket(url);

  sock.onopen = () => {
    retryIn = 500;
    setStatus("");
    const s = session();
    if (state.pendingIntent) {
      send(state.pendingIntent);
      state.pendingIntent = null;
    } else if (s && s.code && s.token) {
      send({ t: "join", code: s.code, token: s.token, name: s.name });
    } else {
      send({ t: "browse" });
    }
  };

  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };

  sock.onclose = () => {
    setStatus(t("c.weg", {}, "Verbindung weg – neuer Versuch …"));
    setTimeout(connect, retryIn);
    retryIn = Math.min(retryIn * 1.8, 8000);
  };
}

// Lebenszeichen alle 25 s. Der Server schließt jede Verbindung, die 65 s lang
// schweigt (die Geisterwache in `server.js`) – wer eine Weile nur zusieht und
// nichts drückt, flog dadurch mitten im Spiel aus dem Raum. Gleicher Takt wie
// in `gemeinsam/schale.js`; dieser Client hat die Schale nicht und schickt den
// Ping selbst.
setInterval(() => send({ t: "ping", c: Date.now() }), 25000);

// ---------------------------------------------------------------------------
// Bildschirme
// ---------------------------------------------------------------------------

function show(name) {
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.toggle("active", s.id === `screen-${name}`);
  }
  if (name === "home") send({ t: "browse" });
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").classList.toggle("show", !!text);
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast._id);
  toast._id = setTimeout(() => t.classList.remove("show"), 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ---------------------------------------------------------------------------
// Nachrichten vom Server
// ---------------------------------------------------------------------------

function onMessage(msg) {
  switch (msg.t) {
    case "rooms":
      renderRooms(msg.rooms);
      break;

    case "joined":
      state.you = msg.you;
      state.code = msg.code;
      saveSession({ code: msg.code, token: msg.token, name: $("name").value.trim() });
      location.hash = msg.code;
      break;

    case "room":
      state.room = msg;
      if (msg.phase !== "playing") {
        state.runde = null;
        state.letzteRunde = null;
      }
      renderRoom();
      break;

    case "runde":
      state.runde = msg;
      renderRunde();
      break;

    case "final":
      renderFinal(msg);
      break;

    case "error":
      toast(msg.msg);
      show("home");
      break;
  }
}

// ---------------------------------------------------------------------------
// Offene Räume
// ---------------------------------------------------------------------------

function renderRooms(list) {
  const box = $("roomList");
  $("roomsCount").textContent = list.length ? `(${list.length})` : "";
  if (!list.length) {
    box.innerHTML = `<p class="rooms-empty">${
      t("c.keinRaum", {}, "Gerade ist kein Raum offen. Eröffne einen – er erscheint dann bei den anderen in der Liste.")
    }</p>`;
    return;
  }
  box.innerHTML = list.map((r) => `
    <button class="roomrow" data-code="${escapeHtml(r.code)}">
      <span class="roomrow-name">${escapeHtml(r.host)}</span>
      <span class="roomrow-meta">${escapeHtml(MODUS_TEXT[r.modus] ?? r.modus)}</span>
      <span class="roomrow-count">${r.count}/${r.max}</span>
    </button>`).join("");

  for (const b of box.querySelectorAll(".roomrow")) {
    b.addEventListener("click", () => joinCode(b.dataset.code));
  }
}

// Gemeinsam mit den anderen Spielen: wer bei einem seinen Namen eintippt,
// findet ihn beim nächsten schon vor.
const NAME_KEY = "spiele_name";

function meinName() {
  return $("name").value.trim();
}

function joinCode(code) {
  try {
    localStorage.setItem(NAME_KEY, meinName());
  } catch { /* egal */ }
  state.pendingIntent = { t: "join", code, token: tokenFuer(code), name: meinName() };
  if (sock?.readyState === WebSocket.OPEN) {
    send(state.pendingIntent);
    state.pendingIntent = null;
  }
}

function verlassen() {
  send({ t: "leave" });
  saveSession(null);
  state.room = null;
  state.runde = null;
  state.you = null;
  location.hash = "";
  show("home");
}

// ---------------------------------------------------------------------------
// Startseite
// ---------------------------------------------------------------------------

function setModus(m) {
  state.modus = m;
  for (const b of document.querySelectorAll("[data-modus]")) {
    b.classList.toggle("sel", b.dataset.modus === m);
  }
  $("modusNote").textContent = m === "nurdrehen"
    ? t("fl.noteNurdrehen", {}, "Nur die Flasche. Was danach kommt, macht ihr euch selbst aus.")
    : m === "frech"
    ? t("fl.noteFrech", {}, "Peinlich, aber jugendfrei: kein Alkohol, kein Körperkontakt.")
    : t("fl.noteHarmlos", {}, "Karten, die man am Familientisch vorlesen kann.");
}

for (const b of document.querySelectorAll("[data-modus]")) {
  b.addEventListener("click", () => setModus(b.dataset.modus));
}

for (const b of document.querySelectorAll("[data-vis]")) {
  b.addEventListener("click", () => {
    state.visibility = b.dataset.vis;
    for (const x of document.querySelectorAll("[data-vis]")) {
      x.classList.toggle("sel", x === b);
    }
  });
}

$("createBtn").addEventListener("click", () => {
  try {
    localStorage.setItem(NAME_KEY, meinName());
  } catch { /* egal */ }
  state.pendingIntent = {
    t: "create",
    name: meinName(),
    isPublic: state.visibility === "public",
    modus: state.modus,
  };
  if (sock?.readyState === WebSocket.OPEN) {
    send(state.pendingIntent);
    state.pendingIntent = null;
  }
});

$("joinBtn").addEventListener("click", () => {
  const code = $("codeInput").value.toUpperCase().trim();
  if (code.length < 3) return toast(t("c.codeBitte", {}, "Bitte den vierstelligen Code eingeben"));
  joinCode(code);
});

$("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("joinBtn").click();
});

$("helpBtn").addEventListener("click", () => { $("help").hidden = false; });
$("helpClose").addEventListener("click", () => { $("help").hidden = true; });

// ---------------------------------------------------------------------------
// Warteraum
// ---------------------------------------------------------------------------

function renderRoom() {
  const r = state.room;
  if (!r) return;

  if (r.phase === "final") return; // das Endbild steht schon
  if (r.phase === "playing") {
    renderPunktleiste();
    return;                        // den Spielbildschirm zeichnet renderRunde()
  }

  show("lobby");

  $("roomCode").textContent = r.code;
  const da = r.players.filter((p) => p.connected).length;
  $("lobbyCount").textContent = `${da}/${r.maxPlayers}`;
  $("roomVis").textContent =
    (r.isPublic
      ? t("c.oeffentlich", {}, "Öffentlich – steht in der Liste")
      : t("c.privat", {}, "Privat – nur mit Code")) +
    " · " + MODUS_TEXT[r.settings.modus];

  const list = $("playerList");
  list.textContent = "";
  const plaetze = Math.max(r.players.length + 1, 4);
  for (let i = 0; i < Math.min(plaetze, r.maxPlayers); i++) {
    const p = r.players[i];
    const card = document.createElement("div");
    card.className = "seat" + (p ? "" : " empty") +
      (p?.ready ? " ready" : "") + (p && !p.connected ? " off" : "");
    if (!p) {
      card.innerHTML =
        `<div class="av">🪑</div><div class="nm">${t("c.frei", {}, "frei")}</div>` +
        `<div class="st">${t("c.wartet", {}, "wartet")}</div>`;
    } else {
      card.innerHTML = `
        <div class="av">${avatarFor(p.id)}</div>
        <div class="nm">${escapeHtml(p.name)}${p.id === state.you ? t("c.du", {}, " (du)") : ""}</div>
        <div class="st">${
        !p.connected
          ? t("fl.weg", {}, "weg")
          : p.host
          ? t("fl.startet", {}, "startet")
          : p.ready
          ? t("fl.bereit", {}, "✓ bereit")
          : t("c.wartet", {}, "wartet")
      }</div>
        ${p.host ? `<div class="host">${t("c.host", {}, "HOST")}</div>` : ""}`;
    }
    list.append(card);
  }

  const isHost = r.hostId === state.you;
  const me = r.players.find((p) => p.id === state.you);
  $("hostControls").hidden = !isHost;
  $("guestControls").hidden = isHost;

  for (const b of document.querySelectorAll("[data-lobbymodus]")) {
    b.classList.toggle("sel", b.dataset.lobbymodus === r.settings.modus);
  }
  for (const b of document.querySelectorAll("[data-rounds]")) {
    b.classList.toggle("sel", Number(b.dataset.rounds) === r.settings.rounds);
  }
  for (const b of document.querySelectorAll("[data-lobbyvis]")) {
    b.classList.toggle("sel", (b.dataset.lobbyvis === "public") === r.isPublic);
  }

  // Wer gerade weg ist, zählt nicht mit – sonst blockiert er den Start.
  const here = r.players.filter((p) => p.connected);
  const others = here.filter((p) => p.id !== r.hostId);
  const allReady = others.every((p) => p.ready);
  $("startBtn").disabled = here.length < r.minPlayers || !allReady;
  $("startHint").textContent = here.length < r.minPlayers
    ? t("fl.zuDritt", {}, "Zu dritt geht es los – zu zweit zeigt die Flasche jedes Mal auf denselben.")
    : allReady
    ? t("c.alleBereit", {}, "Alle bereit!")
    : t("fl.warten", {}, "Warten auf die anderen …");

  $("readyBtn").textContent = me?.ready
    ? t("fl.dochNicht", {}, "Doch nicht bereit")
    : t("schale.bereitKnopf", {}, "Bereit!");
  $("readyBtn").classList.toggle("on", !!me?.ready);
}

$("readyBtn").addEventListener("click", () => {
  const me = state.room?.players.find((p) => p.id === state.you);
  send({ t: "ready", value: !me?.ready });
});

$("startBtn").addEventListener("click", () => send({ t: "start" }));
$("leaveBtn").addEventListener("click", verlassen);
// Derselbe Weg hinaus von ueberall: Lobby, Spielbildschirm, Endstand.
for (const b of document.querySelectorAll("[data-raus]")) {
  b.addEventListener("click", verlassen);
}


for (const b of document.querySelectorAll("[data-lobbymodus]")) {
  b.addEventListener("click", () => send({ t: "settings", modus: b.dataset.lobbymodus }));
}
for (const b of document.querySelectorAll("[data-rounds]")) {
  b.addEventListener("click", () => send({ t: "settings", rounds: Number(b.dataset.rounds) }));
}
for (const b of document.querySelectorAll("[data-lobbyvis]")) {
  b.addEventListener("click", () =>
    send({ t: "settings", isPublic: b.dataset.lobbyvis === "public" })
  );
}

$("copyBtn").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "#" + (state.code ?? "");
  try {
    await navigator.clipboard.writeText(link);
    toast(t("schale.kopiert", {}, "Link kopiert"));
  } catch {
    // Ohne Zwischenablage (http, altes Handy) bleibt nur Vorlesen.
    toast(link);
  }
});

// ---------------------------------------------------------------------------
// Spielbildschirm
// ---------------------------------------------------------------------------

function knopf(label, cls, fn) {
  const b = document.createElement("button");
  b.className = "btn " + cls;
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

/** Die Namen auf dem Kreis verteilen. Position 0 liegt oben, dann im Uhrzeigersinn. */
function zeichneKreis(r) {
  const kreis = $("kreis");
  for (const alt of kreis.querySelectorAll(".platz")) alt.remove();

  const n = r.kreis.length;
  r.kreis.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "platz" +
      (p.id === state.you ? " ich" : "") +
      (!p.da ? " weg" : "") +
      (p.id === r.dreherId ? " dreher" : "") +
      (p.id === r.zielId && r.schritt !== "dreht" ? " ziel" : "");
    // Der Winkel muss zu dem passen, den der Server für die Flasche schickt.
    // Kein Versatz: die Platzierung dreht den Vektor „nach oben", Platz 0
    // liegt also schon oben – genau da, wohin die Flasche bei 0° zeigt.
    // Ein zusätzliches -90 hier lässt die Flasche um eine Vierteldrehung
    // daneben zeigen, und das fällt erst am Bild auf, nie an der Probe.
    const grad = (i / n) * 360;
    el.style.setProperty("--grad", `${grad}deg`);
    el.innerHTML = `<span class="platz-av">${avatarFor(p.id)}</span>
      <span class="platz-name">${escapeHtml(p.name)}</span>`;
    kreis.append(el);
  });
}

function renderRunde() {
  const r = state.runde;
  if (!r || state.room?.phase !== "playing") return;
  show("game");

  const isHost = state.room.hostId === state.you;
  const binDreher = r.dreherId === state.you;
  const binZiel = r.zielId === state.you;

  $("rundeNo").textContent = String(r.n);
  $("rundeTotal").textContent = r.total ? ` / ${r.total}` : "";
  $("modusTag").textContent = r.modus
    ? t("fl.modus." + r.modus, {}, MODUS_TEXT[r.modus] ?? "")
    : "";
  $("endeBtn").hidden = !isHost;

  zeichneKreis(r);

  // --- Die Flasche ---------------------------------------------------------
  const flasche = $("flasche");
  if (r.winkel == null) {
    // Neue Runde: die Flasche bleibt liegen, wo sie ist. Sie auf 0 zu setzen
    // hieße, sie ohne Grund zurückzudrehen.
    flasche.style.transition = "none";
    flasche.classList.remove("dreht");
  } else if (r.schritt === "dreht") {
    // Nur beim tatsächlichen Übergang animieren, nicht bei jedem erneuten
    // Zeichnen – sonst startet die Drehung bei jedem Zustandsupdate neu.
    if (state.letzteRunde !== `${r.n}:dreht`) {
      state.winkelStand = r.winkel;
      flasche.style.transition =
        `transform ${r.drehMs}ms cubic-bezier(.17,.67,.16,1)`;
      flasche.classList.add("dreht");
      // Im nächsten Bild setzen, sonst fasst der Browser Klassenwechsel und
      // Transform zusammen und es gibt gar keine Animation.
      requestAnimationFrame(() => {
        flasche.style.transform = `rotate(${r.winkel}deg)`;
      });
    }
  } else {
    // Nach der Drehung: Endstand halten, ohne neu zu animieren.
    flasche.style.transition = "none";
    flasche.style.transform = `rotate(${r.winkel}deg)`;
    flasche.classList.remove("dreht");
  }
  state.letzteRunde = `${r.n}:${r.schritt}`;

  // --- Karte ---------------------------------------------------------------
  const karte = $("karte");
  karte.hidden = r.schritt !== "aufgabe" || !r.karte;
  if (!karte.hidden) {
    karte.classList.toggle("pflicht", r.wahl === "pflicht");
    $("karteKopf").textContent = r.wahl === "wahrheit"
      ? t("fl.wahrheit", {}, "Wahrheit")
      : t("fl.pflicht", {}, "Pflicht");
    $("karteText").textContent = r.karte;
  }

  // --- Text und Knöpfe -----------------------------------------------------
  const box = $("aktionen");
  box.textContent = "";
  let phase = "";
  let hint = "";

  if (r.schritt === "bereit") {
    phase = binDreher
      ? t("fl.duDrehst", {}, "Du drehst")
      : t("fl.drehtName", { name: r.dreherName }, `${r.dreherName} dreht`);
    if (binDreher) {
      box.append(knopf(t("fl.flascheDrehen", {}, "Flasche drehen"), "primary big",
        () => send({ t: "drehen" })));
      hint = t("fl.drehtGleichzeitig", {}, "Die Flasche dreht sich bei allen gleichzeitig.");
    } else {
      hint = t("fl.wartenAuf", { name: r.dreherName }, `Warten auf ${r.dreherName}.`);
      if (isHost) box.append(knopf(t("fl.drehen", {}, "Drehen"), "ghost sm", () => send({ t: "drehen" })));
    }
    box.append(knopf(t("fl.ueberspringen", {}, "Überspringen"), "ghost sm",
      () => send({ t: "ueberspringen" })));
  } else if (r.schritt === "dreht") {
    phase = "…";
    hint = "";
  } else if (r.schritt === "fertig") {
    // Modus „Nur drehen": die Flasche hat entschieden, mehr macht das Spiel nicht.
    phase = binZiel
      ? t("fl.zeigtAufDich", {}, "Sie zeigt auf dich")
      : t("fl.zeigtAuf", { name: r.zielName }, `Sie zeigt auf ${r.zielName}`);
    hint = t("fl.machtIhrAus", {}, "Was jetzt passiert, macht ihr euch selbst aus.");
    if (binZiel || isHost) {
      box.append(knopf(t("fl.weiter", {}, "Weiter"), "primary big", () => send({ t: "fertig" })));
    } else {
      hint += " " + t("fl.weiterSobald", { name: r.zielName },
        `Weiter geht’s, sobald ${r.zielName} drückt.`);
    }
  } else if (r.schritt === "wahl") {
    phase = binZiel
      ? t("fl.zeigtAufDich", {}, "Sie zeigt auf dich")
      : t("fl.zeigtAuf", { name: r.zielName }, `Sie zeigt auf ${r.zielName}`);
    if (binZiel) {
      box.append(knopf(t("fl.wahrheit", {}, "Wahrheit"), "wahl wahrheit",
        () => send({ t: "wahl", wahl: "wahrheit" })));
      box.append(knopf(t("fl.pflicht", {}, "Pflicht"), "wahl pflicht",
        () => send({ t: "wahl", wahl: "pflicht" })));
      hint = t("fl.suchDirAus", {}, "Such dir aus, was du lieber machst.");
    } else {
      hint = t("fl.waehltZwischen", { name: r.zielName },
        `${r.zielName} wählt zwischen Wahrheit und Pflicht.`);
    }
  } else if (r.schritt === "aufgabe") {
    phase = binZiel
      ? t("fl.duBistDran", {}, "Du bist dran")
      : t("fl.istDran", { name: r.zielName }, `${r.zielName} ist dran`);
    if (binZiel || isHost) {
      box.append(knopf(t("fl.erledigt", {}, "Erledigt"), "primary", () => send({ t: "fertig" })));
      box.append(knopf(t("fl.andereKarte", {}, "Andere Karte"), "ghost sm", () => send({ t: "andere" })));
      box.append(knopf(t("fl.auslassen", {}, "Auslassen"), "ghost sm", () => send({ t: "auslassen" })));
      hint = binZiel
        ? t("fl.auslassenOk", {}, "Auslassen ist erlaubt und kostet nichts – es wird nur mitgezählt.")
        : "";
    } else {
      hint = t("fl.weiterSobald", { name: r.zielName },
        `Weiter geht’s, sobald ${r.zielName} drückt.`);
    }
  }

  $("phasenText").textContent = phase;
  $("rundenHint").textContent = hint;
  renderPunktleiste();
}

function renderPunktleiste() {
  const r = state.room;
  if (!r) return;
  const bar = $("punktleiste");
  bar.textContent = "";
  const sorted = r.players.slice().sort((a, b) => b.getroffen - a.getroffen);
  for (const p of sorted) {
    const chip = document.createElement("div");
    chip.className = "chip" + (p.id === state.you ? " me" : "") +
      (p.connected ? "" : " gone");
    chip.innerHTML = `
      <span class="chip-av">${avatarFor(p.id)}</span>
      <span class="chip-name">${escapeHtml(p.name)}</span>
      <span class="chip-zahl">${p.getroffen}</span>`;
    bar.append(chip);
  }
}

$("endeBtn").addEventListener("click", () => send({ t: "ende" }));

// ---------------------------------------------------------------------------
// Endstand
// ---------------------------------------------------------------------------

function renderFinal(msg) {
  show("final");
  const t = msg.tabelle;
  $("finalSub").textContent = `${msg.runden} Runde${msg.runden === 1 ? "" : "n"} gespielt`;

  const ol = $("podium");
  ol.textContent = "";
  const max = Math.max(...t.map((p) => p.getroffen), 0);
  for (const p of t) {
    const li = document.createElement("li");
    li.className = "podest" + (p.id === state.you ? " me" : "") +
      (max > 0 && p.getroffen === max ? " sieg" : "");
    const titel = max > 0 && p.getroffen === max
      ? "hatte die Flasche gepachtet"
      : p.getroffen === 0
      ? "nie getroffen worden"
      : p.pflichten > p.wahrheiten
      ? `${p.pflichten}× Pflicht genommen`
      : p.wahrheiten
      ? `${p.wahrheiten}× Wahrheit genommen`
      : "";
    li.innerHTML = `
      <span class="podest-av">${avatarFor(p.id)}</span>
      <span class="podest-name">${escapeHtml(p.name)}
        ${titel ? `<small>${escapeHtml(titel)}</small>` : ""}</span>
      <span class="podest-zahl">${p.getroffen}<small>× getroffen</small></span>`;
    ol.append(li);
  }

  const isHost = state.room?.hostId === state.you;
  $("againBtn").hidden = !isHost;
  $("againHint").textContent = isHost
    ? "Zurück in den Warteraum – dort könnt ihr die Karten umstellen."
    : "Der Host holt alle zurück in den Warteraum.";
}

$("againBtn").addEventListener("click", () => send({ t: "again" }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  const gemerkt = localStorage.getItem(NAME_KEY);
  if (gemerkt) $("name").value = gemerkt;
} catch { /* egal */ }

// Geteilter Link mit #CODE: Code eintragen und – wenn der Name schon feststeht –
// direkt beitreten.
const hash = location.hash.replace("#", "").toUpperCase().trim();
if (hash.length >= 3 && hash.length <= 5) {
  $("codeInput").value = hash;
  if (!session()?.token && $("name").value.trim()) {
    state.pendingIntent = { t: "join", code: hash, token: tokenFuer(hash), name: meinName() };
  }
}

setModus("harmlos");
connect();
