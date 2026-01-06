# Biblioteca Scott v2 (Firebase Auth + Google Books)

## 1) Install
- Unzip
- `npm install`
- `npm run dev`

## 2) Firebase setup (required)
1. Create Firebase project
2. Add a Web App and copy config into `src/firebase.js`
3. Enable Authentication -> Email/Password
4. Create Firestore Database

## 3) Allowed family emails
Edit `ALLOWED_EMAILS` in `src/App.jsx`.
(You asked: start with 2, later extend to 5.)

## Notes
- Data stored in Firestore under: `libraries/biblioteca-scott/...`
- Cover images are stored as compressed JPEG data URLs in each book document (simple).
  If later you want unlimited/safer images, we can move them to Firebase Storage.


## v4A — Camera ISBN (mass catalog)
- Scanner ISBN in-app (getUserMedia) con autofocus best-effort
- Conferma solo dopo 2 letture consecutive uguali
- Crop + contrast per migliorare detection
- Copertina catalogo salvata come URL (robusto)
