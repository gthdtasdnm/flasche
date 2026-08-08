# Flaschendrehen 🍾

Reihum dreht einer die Flasche. Sie dreht sich auf **allen** Bildschirmen
gleichzeitig und bleibt bei allen auf derselben Person stehen. Wen sie trifft,
wählt zwischen **Wahrheit** und **Pflicht** – oder ihr spielt im Modus
**Nur drehen**, dann sagt die App nur, wer dran ist, und den Rest macht ihr
euch selbst aus.

Läuft auf **Deno**, ohne eine einzige externe Abhängigkeit. Kein Build-Schritt,
kein `node_modules`, ein Prozess.

---

## Starten

```bash
deno task dev          # http://localhost:8072/
PORT=9000 deno task dev
deno task check        # Typprüfung
deno task probe        # spielt zwei Partien mit vier Clients durch
```

Zum Ausprobieren allein: die Seite in **mehreren Browserfenstern** öffnen. Jedes
Fenster ist ein eigener Spieler (die Sitzung hängt am `sessionStorage`, ein
zweiter Tab im selben Fenster wäre dieselbe Person).

## An den Tisch kommen

Wie bei den anderen Spielen: Name eintippen, **Raum eröffnen** oder über die
Liste bzw. den vierstelligen **Code** beitreten. Der geteilte Link mit `#CODE`
führt direkt hinein.

**Drei bis zehn** Leute. Drei ist keine Willkür: zu zweit zeigt die Flasche
jedes Mal auf denselben – das ist kein Drehen mehr, sondern eine Ansage.

## Eine Runde

1. **Reihum dreht einer.** Wer dran ist, hat den großen Knopf; der Host kann
   einspringen, wenn jemand hängt.
2. **Die Flasche dreht** – drei bis sechs volle Umdrehungen, gut drei Sekunden.
   In dieser Zeit geht nichts anderes.
3. **Sie bleibt auf einer Person stehen.** Nie auf der Person, die gedreht hat.
4. Im Modus **Nur drehen** ist die Runde hier vorbei. Sonst **wählt** die
   getroffene Person Wahrheit oder Pflicht und bekommt eine Karte – sichtbar
   für alle.
5. **Erledigt**, **Andere Karte** oder **Auslassen**. Auslassen ist ausdrücklich
   erlaubt und kostet nichts; es wird nur mitgezählt. Ein Spiel, das jemanden zu
   einer Aufgabe zwingt, hat am Tisch nichts verloren.

Am Ende steht, wen die Flasche am häufigsten getroffen hat.

## Warum der Winkel vom Server kommt

Das ganze Spiel steht und fällt damit, dass die Flasche auf **allen** Geräten
auf dieselbe Person zeigt. Deshalb macht der Server drei Dinge auf einmal:

- Er würfelt das **Ziel** aus.
- Er **friert den Kreis** für die Runde ein. Wer während der Drehung geht,
  verschiebt die Sitzordnung nicht mehr – sonst zeigte die Flasche am Ende
  woandershin, als sie unterwegs war.
- Er schickt den **fertigen Endwinkel**, nicht nur die Position. Der Client
  rechnet nichts aus und kann sich folglich auch nicht verrechnen.

Die Verabredung dahinter ist eine einzige Zeile wert, weil an ihr alles hängt:

> **Platz 0 liegt oben. Gezählt wird im Uhrzeigersinn. Die Flasche zeigt bei 0°
> nach oben.**

Wer im Client die Anordnung ändert, muss den Winkel im Server mitändern – und
umgekehrt.

### Der Fehler, der das gekostet hat

Beim Bauen hatte der Client einen zusätzlichen `-90`-Versatz in der
Platzierung. Ergebnis: alle Namen standen richtig im Kreis, die Markierung saß
auf der richtigen Person, `probe.js` war grün – und die Flasche zeigte trotzdem
**eine Vierteldrehung daneben**. Serverseitig war alles stimmig; der Fehler saß
allein zwischen zwei Winkelkonventionen.

Deshalb gibt es zusätzlich zur `probe.js` einen Browserlauf, der die tatsächlich
gerenderte Drehung aus der CSS-Matrix liest und mit der Position des markierten
Platzes vergleicht:

```bash
cd /root/werkzeug-screenshots
node pruefe-flasche.mjs
```

## Die Karten

`aufgaben.js` hat vier Stapel:

| Stapel | Inhalt |
|---|---|
| `WAHRHEIT_HARMLOS` | 35 Fragen für den Familientisch |
| `PFLICHT_HARMLOS` | 33 Aufgaben, alle im Sitzen erfüllbar |
| `WAHRHEIT_FRECH` | 29 Fragen über Geständnisse und Peinlichkeiten |
| `PFLICHT_FRECH` | 28 Aufgaben, die Überwindung kosten – mehr nicht |

Drei Modi: **Nur drehen** (gar keine Karten), **Harmlos** (nur die harmlosen
Stapel), **Frech** (beide). Wahrheit und Pflicht haben **getrennte** Stapel;
innerhalb einer Partie wiederholt sich keine Karte, bis ihr Stapel durch ist.
Deshalb zieht der Server und nicht jeder Client für sich.

### Kein 18+, und das mit Absicht

Alle Karten kommen **ohne Alkohol, ohne Sex und ohne Körperkontakt** aus.
„Frech" heißt hier peinlich, nicht anzüglich.

Das ist keine Zimperlichkeit, sondern die billigste Lösung: `SPIELE-IDEEN.md`
verlangt für alles aus der Trinkspiel-Sparte einen eigenen Bereich mit
Volljährigkeitshinweis, „trinkfrei" als Voreinstellung und eine
Jugendschutz-Abwägung (JMStG). Wer den Stapel später erweitert, holt sich diese
ganze Abwägung mit dazu – und die Altersabfrage aus `/nochnie/`, die dort als
offener Punkt in `RISIKEN-TODO.md` steht.

`probe.js` hält das fest: es prüft jede einzelne Karte gegen eine Wortliste
(`trink`, `schluck`, `bier`, `kuss`, `nackt` …) und schlägt an, sobald jemand
diese Grenze verschiebt.

Zwei weitere Regeln, die `probe.js` prüft: **Wahrheiten sind Fragen** (enden auf
`?`), **Pflichten sind Anweisungen** (nicht). Ein verrutschter Text fällt damit
sofort auf.

Zwei Regeln, die `probe.js` **nicht** prüfen kann und die deshalb im Kopf von
`aufgaben.js` stehen: jede Pflicht muss **im Sitzen am Tisch** erfüllbar sein,
und sie darf **niemanden anfassen** und niemanden bloßstellen, der nicht
mitspielt.

Alle Texte sind selbst geschrieben, aus keiner Anleitung und keiner App
abgetippt.

## Wenn jemand geht

- **Während die Flasche dreht** wird nichts angefasst. Der Timer löst die Runde
  gleich ohnehin auf, und ein Abbruch mitten in der Drehung sähe aus wie ein
  Fehler.
- **Hängt die Runde an der Person** – sie soll drehen oder sie wurde getroffen –
  wird die Runde neu vergeben, ohne zu zählen.
- **Alle anderen** verschieben nichts: der eingefrorene Kreis bleibt stehen und
  zeigt sie nur als abwesend.

## Dateien

| Datei | Was |
|---|---|
| `server.js` | statische Dateien, WebSocket, Räume, Ziel und Winkel |
| `aufgaben.js` | die vier Kartenstapel |
| `bremse.js` | gemeinsames Rate-Limiting, **wortgleich in allen Spielen** |
| `probe.js` | zwei Partien mit vier Clients, prüft auch die Kartenregeln |
| `public/index.html` | alle vier Bildschirme plus die Hilfe |
| `public/style.css` | oben der gemeinsame Lobby-Block, darunter Kreis und Flasche |
| `public/app.js` | Verbindung, Warteraum, Kreis, Drehung, Karte |

`bremse.js` und der CSS-Block bis `══ Gemeinsame Lobby-Basis ══ Ende ══` sind in
allen Spielen identisch und werden **von Hand** synchron gehalten.

Die Flasche ist eine **CSS-Form**, kein Emoji: ein Emoji zeigt je nach Schrift
in eine andere Richtung, und die Drehung läge dann auf jedem Gerät anders
daneben.

## Betrieb

Port **8072**, gebunden auf `127.0.0.1`, davor Apache als Reverse Proxy unter
`/flasche/`. Dienst: `flasche.service` (systemd, läuft als `www-data`).

```bash
systemctl status flasche
journalctl -u flasche -f
```

Der Zustand liegt vollständig im RAM. Ein Neustart wirft alle laufenden Partien
weg – das ist gewollt, es gibt nichts zu sichern.
