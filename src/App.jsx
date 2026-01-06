import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { NotFoundException } from "@zxing/library";
import { styles } from "./ui.js";
import {
  clearAllData,
  deleteBook,
  exportBackupJSON,
  getLocations,
  importBackupJSON,
  listBooks,
  makeId,
  setLocations,
  upsertBook,
} from "./data.js";

import { auth } from "./firebase";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const ALLOWED_EMAILS = [
  "paolodandrea27@gmail.com",
  "niccolodonatodandrea@gmail.com",
];

function norm(s){ return (s||"").toString().trim(); }
function normKey(s){ return norm(s).toLowerCase(); }

function matches(book, q){
  if(!q) return true;
  const qq = normKey(q);
  return (
    normKey(book.title).includes(qq) ||
    normKey(book.authorLast).includes(qq) ||
    normKey(book.authorFirst).includes(qq) ||
    normKey(book.location).includes(qq) ||
    normKey(book.archive).includes(qq) ||
    normKey(book.isbn).includes(qq)
  );
}

function splitAuthor(full){
  const s = norm(full);
  if(!s) return {last:"", first:""};
  if(s.includes(",")){
    const [last, first] = s.split(",").map(x=>norm(x));
    return {last, first};
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if(parts.length===1) return {last:parts[0], first:""};
  return { last: parts[parts.length-1], first: parts.slice(0,-1).join(" ") };
}

function cleanISBN(raw){
  const s = norm(raw).replace(/[^0-9Xx]/g,"").toUpperCase();
  return s.length>13 ? s.slice(0,13) : s;
}
function isValidISBN(s){
  const x = cleanISBN(s);
  return x.length===10 || x.length===13;
}


function supportsBarcodeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

function pickBestCamera(devices) {
  const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
  return (back || devices[0] || null)?.deviceId || undefined;
}

async function getBestVideoStream() {
  // Strategy (important for Safari on iOS and also for macOS webcams):
  // 1) Try facingMode=environment (ideal on phones)
  // 2) If we can identify a "back" camera by label, try deviceId exact (no facingMode)
  // 3) Fallback to plain { video: true }
  const ideal = { width: { ideal: 1280 }, height: { ideal: 720 } };

  // Attempt 1: facingMode environment
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, ...ideal },
      audio: false,
    });
  } catch (e) {
    // continue
  }

  // Attempt 2: choose by deviceId (after permission, labels are usually available)
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput"
    );
    const deviceId = pickBestCamera(devices);
    if (deviceId) {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, ...ideal },
        audio: false,
      });
    }
  } catch (e) {
    // continue
  }

  // Attempt 3: generic
  return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
}

async function tryApplyFocus(videoTrack) {
  try {
    const caps = videoTrack.getCapabilities?.() || {};
    const settings = videoTrack.getSettings?.() || {};
    const adv = [];
    if (caps.focusMode && Array.isArray(caps.focusMode)) {
      if (caps.focusMode.includes("continuous")) adv.push({ focusMode: "continuous" });
      else if (caps.focusMode.includes("auto")) adv.push({ focusMode: "auto" });
    }
    if (caps.zoom) {
      const zmin = caps.zoom.min ?? 1;
      const zmax = caps.zoom.max ?? 1;
      const z = Math.min(Math.max(1.2, zmin), zmax);
      if (z !== (settings.zoom ?? 1)) adv.push({ zoom: z });
    }
    if (adv.length) await videoTrack.applyConstraints({ advanced: adv });
  } catch {}
}

function CameraISBNScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stopRef = useRef(false);
  const lastRef = useRef({ value: "", hits: 0 });
  const [status, setStatus] = useState("Avvio fotocamera…");
  const [error, setError] = useState("");

  useEffect(() => {
    stopRef.current = false;

    async function start() {
      setError("");
      setStatus("Cerco la fotocamera…");
      let stream;
      try {
        // Important: avoid mixing deviceId EXACT + facingMode on some browsers (notably Safari).
        // We use a progressive strategy that works on iPhone/iPad and doesn't break Macs.
        stream = await getBestVideoStream();
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;

        const [track] = stream.getVideoTracks();
        await tryApplyFocus(track);

        await video.play();
        setStatus("Inquadra il codice a barre ISBN (EAN-13 978/979)…");

        if (supportsBarcodeDetector()) {
          const detector = new window.BarcodeDetector({ formats: ["ean_13"] });
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });

          const loop = async () => {
            if (stopRef.current) return;
            try {
              const w = video.videoWidth || 0;
              const h = video.videoHeight || 0;
              if (w && h) {
                canvas.width = w;
                canvas.height = h;
                ctx.drawImage(video, 0, 0, w, h);

                // Center-lower band crop
                const cx = Math.floor(w * 0.10);
                const cy = Math.floor(h * 0.55);
                const cw = Math.floor(w * 0.80);
                const ch = Math.floor(h * 0.30);
                const imageData = ctx.getImageData(cx, cy, cw, ch);
                const d = imageData.data;
                for (let i = 0; i < d.length; i += 4) {
                  const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
                  const v = g > 160 ? 255 : 0;
                  d[i] = d[i + 1] = d[i + 2] = v;
                }
                ctx.putImageData(imageData, cx, cy);

                const codes = await detector.detect(canvas);
                if (codes && codes.length) {
                  const raw = codes[0].rawValue || "";
                  const cleaned = cleanISBN(raw);
                  if (cleaned) {
                    const last = lastRef.current;
                    if (last.value === cleaned) last.hits += 1;
                    else lastRef.current = { value: cleaned, hits: 1 };
                    if (lastRef.current.hits >= 2) {
                      onDetected(cleaned);
                      return;
                    }
                  }
                }
              }
            } catch {}
            setTimeout(loop, 120);
          };
          loop();
          return;
        }

        const reader = new BrowserMultiFormatReader();
        const decodeLoop = async () => {
          if (stopRef.current) return;
          try {
            const result = await reader.decodeOnceFromVideoElement(video);
            const cleaned = cleanISBN(result?.getText?.() || result?.text || "");
            if (cleaned) {
              const last = lastRef.current;
              if (last.value === cleaned) last.hits += 1;
              else lastRef.current = { value: cleaned, hits: 1 };
              if (lastRef.current.hits >= 2) {
                onDetected(cleaned);
                return;
              }
            }
          } catch (e) {
            if (!(e instanceof NotFoundException)) {
              // ignore
            }
          }
          setTimeout(decodeLoop, 120);
        };
        decodeLoop();
      } catch (e) {
        console.error("CAMERA ERROR:", e);
        setError(`Errore camera: ${e?.name || "Unknown"} – ${e?.message || ""}`);
        setStatus("");
      }
    }

    start();

    return () => {
      stopRef.current = true;
      try {
        const s = streamRef.current;
        if (s) s.getTracks().forEach(t => t.stop());
      } catch {}
    };
  }, [onDetected]);

  return (
    <div style={{...styles.card, display:"grid", gap:10}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
        <div style={{fontWeight:900}}>Scanner ISBN</div>
        <button style={styles.btn} onClick={onClose}>Chiudi</button>
      </div>

      <div style={styles.small}>
        Consigli: avvicina il codice, evita riflessi, tieni fermo 1–2 secondi.
      </div>

      <div style={{position:"relative", width:"100%", aspectRatio:"16/9", borderRadius:16, overflow:"hidden", border:"1px solid #eee"}}>
        <video ref={videoRef} playsInline muted style={{width:"100%", height:"100%", objectFit:"cover"}} />
        <div style={{
          position:"absolute", left:"10%", top:"55%", width:"80%", height:"30%",
          border:"2px solid rgba(255,255,255,0.85)", borderRadius:12,
          boxShadow:"0 0 0 9999px rgba(0,0,0,0.20) inset"
        }}/>
      </div>

      {status ? <div style={styles.small}>Stato: {status}</div> : null}
      {error ? <div style={{...styles.small, color:"#b00020"}}>{error}</div> : null}
    </div>
  );
}

async function googleBooksSearch({ isbn, title, author }){
  let q = "";
  const is = cleanISBN(isbn||"");
  if(isValidISBN(is)) q = `isbn:${is}`;
  else q = [norm(title), norm(author)].filter(Boolean).join(" ");
  if(!q) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`;
  const res = await fetch(url);
  if(!res.ok) return [];
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(it=>{
    const v = it.volumeInfo || {};
    const authors = Array.isArray(v.authors) ? v.authors.join(", ") : "";
    const {last, first} = splitAuthor((v.authors?.[0]) || authors);
    const cover = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "";
    const isbn13 = (v.industryIdentifiers||[]).find(x=>x.type==="ISBN_13")?.identifier || "";
    return {
      id: it.id,
      title: v.title || "",
      authorLast: last,
      authorFirst: first,
      publishedDate: v.publishedDate || "",
      publisher: v.publisher || "",
      isbn: isbn13 || is,
      coverUrl: cover,
    };
  });
}

function blobToDataURL(blob){
  return new Promise(resolve=>{
    const r = new FileReader();
    r.onload = ()=>resolve(String(r.result||""));
    r.readAsDataURL(blob);
  });
}

async function downscaleImage(fileOrBlob, maxSide=900, quality=0.78){
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const img = document.createElement("img");
  const url = URL.createObjectURL(blob);
  img.src = url;
  await new Promise((res, rej)=>{ img.onload=res; img.onerror=rej; });
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w,h));
  const nw = Math.round(w*scale);
  const nh = Math.round(h*scale);
  const canvas = document.createElement("canvas");
  canvas.width = nw; canvas.height = nh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img,0,0,nw,nh);
  URL.revokeObjectURL(url);
  return await new Promise(resolve=>canvas.toBlob(b=>resolve(b),"image/jpeg",quality));
}

async function fetchAsDataURL(url){
  if(!url) return "";
  try{
    const res = await fetch(url);
    if(!res.ok) return "";
    const b = await res.blob();
    const resized = await downscaleImage(b, 800, 0.78);
    return await blobToDataURL(resized);
  }catch{ return ""; }
}

function AuthGate(){
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [pass,setPass]=useState("");
  const [status,setStatus]=useState("");

  const allowed = (em)=>ALLOWED_EMAILS.map(x=>x.toLowerCase()).includes((em||"").toLowerCase());

  async function doLogin(){
    setStatus("Accesso in corso…");
    try{
      const cred = await signInWithEmailAndPassword(auth, norm(email), pass);
      if(!allowed(cred.user.email)){
        await signOut(auth);
        setStatus("Questa email non è abilitata.");
        return;
      }
      setStatus("");
    }catch{
      setStatus("Login fallito. Controlla email/password.");
    }
  }
  async function doSignup(){
    const em = norm(email).toLowerCase();
    if(!allowed(em)){
      setStatus("Questa email non è nella lista abilitata.");
      return;
    }
    setStatus("Creo account…");
    try{
      await createUserWithEmailAndPassword(auth, em, pass);
      setStatus("");
    }catch{
      setStatus("Registrazione fallita (password min 6, o email già usata).");
    }
  }

  return (
    <div style={styles.app}>
      <div style={{...styles.card, maxWidth:520, margin:"40px auto", display:"grid", gap:10}}>
        <h1 style={styles.h1}>Biblioteca Scott</h1>
        <div style={styles.small}>Login famiglia (email+password). Email abilitate: {ALLOWED_EMAILS.join(", ")}</div>
        <div style={{display:"flex", gap:10}}>
          <button style={mode==="login"?styles.btnPrimary:styles.btn} onClick={()=>setMode("login")}>Login</button>
          <button style={mode==="signup"?styles.btnPrimary:styles.btn} onClick={()=>setMode("signup")}>Crea account</button>
        </div>
        <div>
          <div style={styles.label}>Email</div>
          <input style={styles.input} value={email} onChange={e=>setEmail(e.target.value)} />
        </div>
        <div>
          <div style={styles.label}>Password</div>
          <input type="password" style={styles.input} value={pass} onChange={e=>setPass(e.target.value)} />
        </div>
        {mode==="login"
          ? <button style={styles.btnPrimary} onClick={doLogin}>Entra</button>
          : <button style={styles.btnPrimary} onClick={doSignup}>Crea account</button>
        }
        {status ? <div style={styles.small}>Stato: {status}</div> : null}
      </div>
    </div>
  );
}

function TopBar({ userEmail, onAdd, onLocations, onBackup, onLogout }){
  return (
    <div style={styles.topbar}>
      <div style={{flex:1}}>
        <h1 style={styles.h1}>Biblioteca Scott</h1>
        <div style={styles.small}>Utente: {userEmail}</div>
      </div>
      <button style={styles.btn} onClick={onLocations}>Location</button>
      <button style={styles.btn} onClick={onBackup}>Backup</button>
      <button style={styles.btn} onClick={onLogout}>Logout</button>
      <button style={styles.btnPrimary} onClick={onAdd}>+ Aggiungi</button>
    </div>
  );
}

function BookCard({ b, onOpen }){
  const personal = b.personalCoverDataUrl || "";
  const catalog = b.catalogCoverUrl || "";
  return (
    <div style={styles.card} onClick={()=>onOpen(b)} role="button" tabIndex={0}>
      <div style={styles.bookRow}>
        <div style={{display:"flex", gap:6, alignItems:"center"}}>
          {personal ? <img alt="" src={personal} style={{...styles.cover, width:46, height:64}}/> : null}
          {catalog ? <img alt="" src={catalog} style={{...styles.cover, width:46, height:64}}/> : null}
          {!personal && !catalog ? <div style={{...styles.cover, width:46, height:64, display:"grid", placeItems:"center", color:"#999"}}>—</div> : null}
        </div>
        <div>
          <div style={{fontWeight:800}}>{(b.authorLast||"")}{b.authorFirst?`, ${b.authorFirst}`:""}</div>
          <div style={{fontSize:16, fontWeight:800}}>{b.title}</div>
          <div style={styles.meta}>
            {b.isbn?`ISBN ${b.isbn} • `:""}{b.location?`📍 ${b.location}`:""}{b.archive?` • 🗂️ ${b.archive}`:""}
          </div>
        </div>
      </div>
    </div>
  );
}


function BookPick({ results, onPick, onCancel }){
  return (
    <div style={{...styles.card, display:"grid", gap:10}}>
      <div style={{fontWeight:900, fontSize:16}}>Seleziona il libro (Google Books)</div>
      <div style={{display:"grid", gap:10}}>
        {results.map(r=>(
          <div key={r.id} style={{...styles.card, padding:12}} onClick={()=>onPick(r)} role="button" tabIndex={0}>
            <div style={styles.bookRow}>
              <img alt="" src={r.coverUrl||""} style={styles.cover}/>
              <div>
                <div style={{fontWeight:800}}>{r.authorLast}{r.authorFirst?`, ${r.authorFirst}`:""}</div>
                <div style={{fontSize:16, fontWeight:800}}>{r.title}</div>
                <div style={styles.small}>{r.publisher?`${r.publisher} • `:""}{r.publishedDate||""}</div>
                <div style={styles.small}>{r.isbn?`ISBN: ${r.isbn}`:""}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{display:"flex", justifyContent:"flex-end"}}>
        <button style={styles.btn} onClick={onCancel}>Annulla</button>
      </div>
    </div>
  );
}
function BookForm({ mode, locations, archives, initial, onCancel, onSave }){
  const [authorLast,setAuthorLast]=useState(initial?.authorLast??"");
  const [authorFirst,setAuthorFirst]=useState(initial?.authorFirst??"");
  const [title,setTitle]=useState(initial?.title??"");
  const [isbn,setIsbn]=useState(initial?.isbn??"");
  const [scannerOpen,setScannerOpen]=useState(false);
  const [status,setStatus]=useState("");
  const [location,setLocation]=useState(initial?.location??(locations[0]||""));
  const [archive,setArchive]=useState(initial?.archive??"");
  const [notes,setNotes]=useState(initial?.notes??"");
  const [personalCoverDataUrl,setPersonal]=useState(initial?.personalCoverDataUrl??"");
  const [catalogCoverUrl,setCatalog]=useState(initial?.catalogCoverUrl??"");
  const [pickResults,setPickResults]=useState(null);

  const pickGalleryRef = useRef(null);
  const pickCameraRef = useRef(null);

  async function onPickPersonal(e){
    const file = e.target.files?.[0];
    if(!file) return;
    const resized = await downscaleImage(file, 900, 0.78);
    const dataUrl = await blobToDataURL(resized);
    setPersonal(dataUrl);
  }

  async function pasteISBN(){
    setStatus("");
    try{
      const t = await navigator.clipboard.readText();
      const cleaned = cleanISBN(t);
      if(cleaned) { setIsbn(cleaned); setStatus("ISBN incollato."); }
    }catch{
      setStatus("Permesso appunti non disponibile: incolla manualmente.");
    }
  }

  

async function onDetectedISBN(value) {
  setScannerOpen(false);
  const cleaned = cleanISBN(value);
  if (cleaned) {
    setIsbn(cleaned);
    setStatus("ISBN letto. Cerco su Google Books…");
    const author = [authorFirst, authorLast].filter(Boolean).join(" ");
    const results = await googleBooksSearch({ isbn: cleaned, title, author });
    if (!results.length) {
      setStatus("ISBN letto, ma Google Books non ha trovato corrispondenze. Puoi riprovare o compilare a mano.");
      return;
    }
    setPickResults(results);
    setStatus("");
  }
}
async function searchGoogle(){
    const cleaned = cleanISBN(isbn);
    if (cleaned && cleaned !== isbn) setIsbn(cleaned);
    setStatus("Cerco su Google Books…");
    const author = [authorFirst, authorLast].filter(Boolean).join(" ");
    const results = await googleBooksSearch({ isbn: cleaned || isbn, title, author });
    if(!results.length){ setStatus("Nessun risultato."); return; }
    setPickResults(results);
    setStatus("");
  }

  async function pick(r){
    setPickResults(null);
    setTitle(r.title||"");
    setAuthorLast(r.authorLast||"");
    setAuthorFirst(r.authorFirst||"");
    if(r.isbn) setIsbn(cleanISBN(r.isbn));
    if (r.coverUrl) {
      setCatalog(r.coverUrl);
    }
    setStatus("Dati compilati da Google Books.");
  }

  const canSave = norm(title).length>0;

  return (
    <div style={{display:"grid", gap:10}}>
      {pickResults ? <BookPick results={pickResults} onPick={pick} onCancel={()=>setPickResults(null)}/> : null}

      <div style={{...styles.card, display:"grid", gap:10}}>
        <div style={{fontWeight:900, fontSize:16}}>{mode==="edit"?"Modifica libro":"Aggiungi libro"}</div>

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          <div>
            <div style={styles.label}>Cognome autore</div>
            <input style={styles.input} value={authorLast} onChange={e=>setAuthorLast(e.target.value)}/>
          </div>
          <div>
            <div style={styles.label}>Nome autore</div>
            <input style={styles.input} value={authorFirst} onChange={e=>setAuthorFirst(e.target.value)}/>
          </div>
        </div>

        <div>
          <div style={styles.label}>Titolo *</div>
          <input style={styles.input} value={title} onChange={e=>setTitle(e.target.value)}/>
        </div>

        <div>
          <div style={styles.label}>ISBN (opzionale)</div>
          <input style={styles.input} value={isbn} onChange={e=>setIsbn(e.target.value)} onKeyDown={(e)=>{ if(e.key==="Enter"){ e.preventDefault(); searchGoogle(); } }} placeholder="978… (Invio per cercare)"/>
          <div style={{display:"flex", gap:10, flexWrap:"wrap", marginTop:8}}>
<button style={styles.btn} onClick={()=>setScannerOpen(true)}>📷 Scanner ISBN</button>
</div>
          {scannerOpen ? (
            <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:16}} onClick={()=>setScannerOpen(false)}>
              <div style={{width:"min(920px, 100%)", maxHeight:"92vh", overflow:"auto", borderRadius:18, background:"#fff", boxShadow:"0 20px 60px rgba(0,0,0,0.35)"}} onClick={(e)=>e.stopPropagation()}>
                <CameraISBNScanner onDetected={onDetectedISBN} onClose={()=>setScannerOpen(false)} />
              </div>
            </div>
          ) : null}
          {status ? <div style={styles.small}>Stato: {status}</div> : <div style={styles.small}>Puoi cercare anche da titolo/autore (se ISBN vuoto).</div>}
        </div>

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          <div>
            <div style={styles.label}>Location</div>
            <select style={styles.select} value={location} onChange={e=>setLocation(e.target.value)}>
              {locations.map(l=><option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <div style={styles.label}>Archivio / sub-location</div>
            <input style={styles.input} value={archive} onChange={e=>setArchive(e.target.value)} list="arch-sug"/>
            <datalist id="arch-sug">
              {archives.map(a=><option key={a} value={a}/>)}
            </datalist>
          </div>
        </div>

        <div>
          <div style={styles.label}>Note</div>
          <textarea style={{...styles.input, height:90, resize:"vertical"}} value={notes} onChange={e=>setNotes(e.target.value)}/>
        </div>

        <div>
          <div style={styles.label}>Copertine (C)</div>
          <div style={styles.small}>Foto personale + Copertina catalogo (puoi eliminare una delle due).</div>

          <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
            <button style={styles.btnPrimary} onClick={()=>pickCameraRef.current?.click()}>📸 Scatta copertina</button>
            <button style={styles.btn} onClick={()=>pickGalleryRef.current?.click()}>🖼️ Scegli da galleria</button>
            <button style={styles.btn} onClick={()=>setPersonal("")} disabled={!personalCoverDataUrl}>🗑️ Elimina foto personale</button>
            <button style={styles.btn} onClick={()=>setCatalog("")} disabled={!catalogCoverUrl}>🗑️ Elimina copertina catalogo</button>
          </div>

          <input ref={pickCameraRef} type="file" accept="image/*" capture="environment" onChange={onPickPersonal} style={{display:"none"}}/>
          <input ref={pickGalleryRef} type="file" accept="image/*" onChange={onPickPersonal} style={{display:"none"}}/>
<div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10}}>
            <div style={{...styles.card, padding:10}}>
{personalCoverDataUrl ? <img alt="" src={personalCoverDataUrl} style={{width:"100%", borderRadius:12, border:"1px solid #eee", marginTop:8}}/> : <div style={styles.small}>Nessuna.</div>}
            </div>
            <div style={{...styles.card, padding:10}}>
              <div style={{fontWeight:800}}>Copertina catalogo</div>
              {catalogCoverUrl ? <img alt="" src={catalogCoverUrl} style={{width:"100%", borderRadius:12, border:"1px solid #eee", marginTop:8}}/> : <div style={styles.small}>Nessuna (usa Cerca/Compila).</div>}
            </div>
          </div>
        </div>

        <div style={{display:"flex", justifyContent:"flex-end", gap:10}}>
          <button style={styles.btn} onClick={onCancel}>Annulla</button>
          <button style={{...styles.btnPrimary, opacity:canSave?1:0.5}} disabled={!canSave} onClick={()=>{
            const now = Date.now();
            onSave({
              ...initial,
              authorLast:norm(authorLast),
              authorFirst:norm(authorFirst),
              title:norm(title),
              isbn:cleanISBN(isbn),
              location:norm(location),
              archive:norm(archive),
              notes:norm(notes),
              personalCoverDataUrl: personalCoverDataUrl||"",
              catalogCoverUrl: catalogCoverUrl||"",
              createdAt: initial?.createdAt ?? now,
              updatedAt: now,
            });
          }}>Salva</button>
        </div>
      </div>
    </div>
  );
}
function Detail({ book, onBack, onEdit, onDelete }){
  const personal = book.personalCoverDataUrl || "";
  const catalog = book.catalogCoverUrl || "";
  return (
    <div style={{display:"grid", gap:10}}>
      <div style={styles.row}><span style={styles.link} onClick={onBack}>← Indietro</span></div>
      <div style={{...styles.card, display:"grid", gap:10}}>
        {personal || catalog ? (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
            <div style={{...styles.card, padding:10}}>
              <div style={{fontWeight:800}}>Foto personale</div>
              {personal ? <img alt="" src={personal} style={{width:"100%", maxHeight:420, objectFit:"contain", borderRadius:12, border:"1px solid #eee", marginTop:8}}/> : <div style={styles.small}>Nessuna.</div>}
            </div>
            <div style={{...styles.card, padding:10}}>
              <div style={{fontWeight:800}}>Copertina catalogo</div>
              {catalog ? <img alt="" src={catalog} style={{width:"100%", maxHeight:420, objectFit:"contain", borderRadius:12, border:"1px solid #eee", marginTop:8}}/> : <div style={styles.small}>Nessuna.</div>}
            </div>
          </div>
        ) : null}
        <div style={{fontSize:20, fontWeight:900}}>{book.authorLast}{book.authorFirst?`, ${book.authorFirst}`:""}</div>
        <div style={{fontSize:18, fontWeight:800}}>{book.title}</div>
        <div style={styles.meta}>{book.isbn?`ISBN: ${book.isbn} • `:""}{book.location?`📍 ${book.location}`:""}{book.archive?` • 🗂️ ${book.archive}`:""}</div>
        {book.notes ? <div style={{whiteSpace:"pre-wrap"}}>{book.notes}</div> : <div style={styles.small}>Nessuna nota.</div>}
        <div style={{display:"flex", gap:10}}>
          <button style={styles.btnPrimary} onClick={onEdit}>Modifica</button>
          <button style={styles.btn} onClick={onDelete}>Elimina</button>
        </div>
      </div>
    </div>
  );
}

function LocationsManager({ locations, onClose, onSave }){
  const [items,setItems]=useState(locations);
  const [newLoc,setNewLoc]=useState("");
  function add(){
    const v = norm(newLoc);
    if(!v || items.includes(v)) return;
    setItems([...items, v]); setNewLoc("");
  }
  function remove(loc){ setItems(items.filter(x=>x!==loc)); }
  return (
    <div style={{display:"grid", gap:10}}>
      <div style={styles.row}><span style={styles.link} onClick={onClose}>← Indietro</span></div>
      <div style={{...styles.card, display:"grid", gap:10}}>
        <div style={{fontWeight:900, fontSize:16}}>Gestione Location</div>
        <div style={{display:"flex", gap:10}}>
          <input style={styles.input} value={newLoc} onChange={e=>setNewLoc(e.target.value)} placeholder="Nuova location"/>
          <button style={styles.btnPrimary} onClick={add}>Aggiungi</button>
        </div>
        <div style={styles.divider}/>
        <div style={{display:"grid", gap:8}}>
          {items.map(loc=>(
            <div key={loc} style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
              <div style={{fontWeight:700}}>{loc}</div>
              <button style={styles.btn} onClick={()=>remove(loc)}>Rimuovi</button>
            </div>
          ))}
        </div>
        <div style={{display:"flex", justifyContent:"flex-end", gap:10}}>
          <button style={styles.btn} onClick={onClose}>Annulla</button>
          <button style={styles.btnPrimary} onClick={()=>onSave(items)}>Salva</button>
        </div>
      </div>
    </div>
  );
}

function BackupManager({ onClose, onDone }){
  const fileRef = useRef(null);
  const [status,setStatus]=useState("");
  async function doExport(){
    setStatus("Creo backup…");
    const payload = await exportBackupJSON();
    const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0,19).replaceAll(":","-");
    a.href = url;
    a.download = `biblioteca-scott-backup-${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setStatus("Backup esportato.");
  }
  async function doImport(file){
    setStatus("Import in corso…");
    const txt = await file.text();
    const data = JSON.parse(txt);
    await importBackupJSON(data, {mode:"merge"});
    setStatus("Import completato.");
    onDone?.();
  }
  async function doReset(){
    const ok = window.confirm("ATTENZIONE: cancello TUTTO. Continuare?");
    if(!ok) return;
    await clearAllData();
    setStatus("Archivio svuotato.");
    onDone?.();
  }
  return (
    <div style={{display:"grid", gap:10}}>
      <div style={styles.row}><span style={styles.link} onClick={onClose}>← Indietro</span></div>
      <div style={{...styles.card, display:"grid", gap:10}}>
        <div style={{fontWeight:900, fontSize:16}}>Backup</div>
        <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
          <button style={styles.btnPrimary} onClick={doExport}>⬇️ Export JSON</button>
          <button style={styles.btn} onClick={()=>fileRef.current?.click()}>⬆️ Import JSON</button>
          <button style={styles.btn} onClick={doReset}>🧹 Reset</button>
          <input ref={fileRef} type="file" accept="application/json" style={{display:"none"}} onChange={e=>{
            const f = e.target.files?.[0];
            if(f) doImport(f);
            e.target.value="";
          }}/>
        </div>
        {status ? <div style={styles.small}>Stato: {status}</div> : null}
      </div>
    </div>
  );
}

export default function App(){
  const [authChecked,setAuthChecked]=useState(false);
  const [authed,setAuthed]=useState(false);
  const [userEmail,setUserEmail]=useState("");

  const [view,setView]=useState("library");
  const [locations,setLocationsState]=useState([]);
  const [books,setBooks]=useState([]);
  const [selected,setSelected]=useState(null);
  const [query,setQuery]=useState("");
  const [filterLocation,setFilterLocation]=useState("");
  const [filterArchive,setFilterArchive]=useState("");

  async function refresh(){
    const locs = await getLocations();
    setLocationsState(locs);
    const b = await listBooks();
    setBooks(b);
  }

  useEffect(()=>{
    const allowed = (em)=>ALLOWED_EMAILS.map(x=>x.toLowerCase()).includes((em||"").toLowerCase());
    const unsub = onAuthStateChanged(auth, async (u)=>{
      setAuthChecked(true);
      if(!u){ setAuthed(false); setUserEmail(""); return; }
      if(!allowed(u.email)){ await signOut(auth); setAuthed(false); setUserEmail(""); return; }
      setAuthed(true); setUserEmail(u.email||"");
      await refresh();
    });
    return ()=>unsub();
    // eslint-disable-next-line
  },[]);

  const archives = useMemo(()=>{
    const s = new Set();
    books.forEach(b=>{ const a=(b.archive||"").trim(); if(a) s.add(a); });
    return Array.from(s).sort((a,b)=>a.localeCompare(b,"it"));
  },[books]);

  const visible = useMemo(()=>{
    return books
      .filter(b=>matches(b,query))
      .filter(b=>filterLocation ? b.location===filterLocation : true)
      .filter(b=>filterArchive ? b.archive===filterArchive : true);
  },[books,query,filterLocation,filterArchive]);

  async function saveBook(form){
    const now = Date.now();
    const book = {
      id: form.id || makeId(),
      authorLast: form.authorLast,
      authorFirst: form.authorFirst,
      title: form.title,
      isbn: form.isbn || "",
      location: form.location || "",
      archive: form.archive || "",
      notes: form.notes || "",
      personalCoverDataUrl: form.personalCoverDataUrl || "",
      catalogCoverUrl: form.catalogCoverUrl || "",
      createdAt: form.createdAt ?? now,
      updatedAt: now,
    };
    await upsertBook(book);
    await refresh();
    setSelected(book);
    setView("detail");
  }

  async function removeSelected(){
    if(!selected) return;
    if(!window.confirm("Eliminare questo libro?")) return;
    await deleteBook(selected.id);
    setSelected(null);
    await refresh();
    setView("library");
  }

  async function saveLocs(locs){
    await setLocations(locs);
    await refresh();
    setView("library");
  }

  async function logout(){
    await signOut(auth);
    setAuthed(false);
    setUserEmail("");
  }

  if(!authChecked) return <div style={styles.app}><div style={styles.card}>Caricamento…</div></div>;
  if(!authed) return <AuthGate/>;

  return (
    <div style={styles.app}>
      {view==="library" && (
        <>
          <TopBar
            userEmail={userEmail}
            onAdd={()=>{ setSelected(null); setView("add"); }}
            onLocations={()=>setView("locations")}
            onBackup={()=>setView("backup")}
            onLogout={logout}
          />
          <div style={{display:"grid", gap:10}}>
            <div style={{...styles.card, display:"grid", gap:10}}>
              <input style={styles.input} placeholder="Cerca…" value={query} onChange={e=>setQuery(e.target.value)}/>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
                <div>
                  <div style={styles.label}>Location</div>
                  <select style={styles.select} value={filterLocation} onChange={e=>setFilterLocation(e.target.value)}>
                    <option value="">Tutte</option>
                    {locations.map(l=><option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <div style={styles.label}>Archivio</div>
                  <select style={styles.select} value={filterArchive} onChange={e=>setFilterArchive(e.target.value)}>
                    <option value="">Tutti</option>
                    {archives.map(a=><option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {visible.length ? (
              <div style={styles.list}>
                {visible.map(b=><BookCard key={b.id} b={b} onOpen={(x)=>{ setSelected(x); setView("detail"); }}/>)}
              </div>
            ) : (
              <div style={{...styles.card, ...styles.small}}>Nessun libro.</div>
            )}
          </div>
        </>
      )}

      {view==="add" && (
        <>
          <div style={styles.row}><span style={styles.link} onClick={()=>setView("library")}>← Indietro</span></div>
          <div style={{height:10}}/>
          <BookForm mode="add" locations={locations} archives={archives} initial={null} onCancel={()=>setView("library")} onSave={saveBook}/>
        </>
      )}

      {view==="detail" && selected && (
        <Detail book={selected} onBack={()=>setView("library")} onEdit={()=>setView("edit")} onDelete={removeSelected}/>
      )}

      {view==="edit" && selected && (
        <>
          <div style={styles.row}><span style={styles.link} onClick={()=>setView("detail")}>← Indietro</span></div>
          <div style={{height:10}}/>
          <BookForm mode="edit" locations={locations} archives={archives} initial={selected} onCancel={()=>setView("detail")} onSave={saveBook}/>
        </>
      )}

      {view==="locations" && (
        <LocationsManager locations={locations} onClose={()=>setView("library")} onSave={saveLocs}/>
      )}

      {view==="backup" && (
        <BackupManager onClose={()=>setView("library")} onDone={refresh}/>
      )}
    </div>
  );
}
