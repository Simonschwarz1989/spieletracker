# Cloud einrichten (einmalig, ca. 10 Minuten)

Damit jeder Mitspieler am eigenen Handy eintragen kann, braucht die App eine gemeinsame Datenbank.
Dafür nutzt sie **Google Firebase** (kostenloser „Spark“-Tarif, keine Kreditkarte nötig).

## 1. Projekt anlegen
1. Öffne <https://console.firebase.google.com> und melde dich mit deinem Google-Konto an.
2. **„Projekt erstellen“** → Name z. B. `spieletracker` → Google Analytics kannst du **ausschalten** → Erstellen.

## 2. Anonyme Anmeldung einschalten
1. Links **Build → Authentication** → „Jetzt starten“.
2. Reiter **Sign-in method** → **Anonym** → aktivieren → Speichern.
   (Deine Mitspieler brauchen so kein Konto – die App meldet jedes Handy unsichtbar an.)

## 3. Datenbank anlegen
1. Links **Build → Firestore Database** → „Datenbank erstellen“.
2. Standort: **europe-west3 (Frankfurt)** → Weiter.
3. **„Im Produktionsmodus starten“** → Erstellen.
4. Reiter **Regeln** → den Inhalt komplett durch den Inhalt der Datei `firestore.rules` ersetzen → **Veröffentlichen**.

## 4. Web-App registrieren
1. Zahnrad oben links → **Projekteinstellungen** → unten „Meine Apps“ → Symbol **`</>`** (Web).
2. Name `Spieletracker` → „App registrieren“ (Hosting-Haken **nicht** nötig).
3. Es erscheint ein Block `const firebaseConfig = { apiKey: "...", ... }`.
   **Diesen Block an Claude schicken** – ich trage ihn in `firebase-config.js` ein.

   (Der apiKey ist kein Geheimnis: Er steckt bei jeder Firebase-Web-App im Code. Geschützt
   wird die Datenbank durch die Regeln aus Schritt 3 – nur wer euren Gruppencode kennt, sieht eure Daten.)

## 5. Danach
- Die App kommt online (Netlify oder GitHub Pages).
- Du öffnest sie, tippst **„Neue Gruppe gründen“** und wählst deinen Namen.
- Unter **Spieler → Einladen** schickst du deinen Mitspielern den Link (z. B. per WhatsApp).
  Sie öffnen ihn, wählen ihren Namen – fertig. Danach „Zum Startbildschirm hinzufügen“.
