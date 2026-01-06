// Simple IndexedDB wrapper for Biblioteca Scott (V1 local)
// Stores books (with optional cover image as Blob) and locations.
// Includes JSON backup export/import (with cover images encoded as data URLs).

const DB_NAME = "biblioteca-scott-db";
const DB_VERSION = 1;

const STORES = {
  books: "books",
  meta: "meta",
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Books store
      if (!db.objectStoreNames.contains(STORES.books)) {
        const store = db.createObjectStore(STORES.books, { keyPath: "id" });
        store.createIndex("by_authorLast", "authorLast", { unique: false });
        store.createIndex("by_title", "title", { unique: false });
        store.createIndex("by_location", "location", { unique: false });
        store.createIndex("by_archive", "archive", { unique: false });
        store.createIndex("by_createdAt", "createdAt", { unique: false });
      }

      // Meta store for locations list etc.
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getLocations() {
  const db = await openDB();
  const tx = db.transaction(STORES.meta, "readonly");
  const store = tx.objectStore(STORES.meta);
  const req = store.get("locations");
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();

  return (
    result ?? [
      "Salone",
      "Camera matrimoniale",
      "Camera Niki",
      "Camera Francesco",
      "Camera Cecilia",
      "Studio",
    ]
  );
}

export async function setLocations(locations) {
  const db = await openDB();
  const tx = db.transaction(STORES.meta, "readwrite");
  tx.objectStore(STORES.meta).put({ key: "locations", value: locations });
  await txDone(tx);
  db.close();
}

export async function listBooks() {
  const db = await openDB();
  const tx = db.transaction(STORES.books, "readonly");
  const store = tx.objectStore(STORES.books);
  const req = store.getAll();
  const books = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();

  // newest first
  return books.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getBook(id) {
  const db = await openDB();
  const tx = db.transaction(STORES.books, "readonly");
  const req = tx.objectStore(STORES.books).get(id);
  const book = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  return book;
}

export async function upsertBook(book) {
  const db = await openDB();
  const tx = db.transaction(STORES.books, "readwrite");
  tx.objectStore(STORES.books).put(book);
  await txDone(tx);
  db.close();
}

export async function deleteBook(id) {
  const db = await openDB();
  const tx = db.transaction(STORES.books, "readwrite");
  tx.objectStore(STORES.books).delete(id);
  await txDone(tx);
  db.close();
}

export async function clearAllData() {
  const db = await openDB();
  const tx1 = db.transaction(STORES.books, "readwrite");
  tx1.objectStore(STORES.books).clear();
  await txDone(tx1);

  const tx2 = db.transaction(STORES.meta, "readwrite");
  tx2.objectStore(STORES.meta).delete("locations");
  await txDone(tx2);

  db.close();
}

export function makeId() {
  // readable + unique enough for local use
  return "b_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36);
}

export async function blobToObjectURL(blob) {
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || null);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  if (!dataUrl) return null;
  const res = await fetch(dataUrl);
  return await res.blob();
}

export async function exportBackupJSON() {
  const locations = await getLocations();
  const books = await listBooks();

  const exportedBooks = [];
  for (const b of books) {
    const coverDataUrl = b.coverBlob ? await blobToDataURL(b.coverBlob) : null;
    const { coverBlob, ...rest } = b;
    exportedBooks.push({ ...rest, coverDataUrl });
  }

  return {
    app: "Biblioteca Scott",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    locations,
    books: exportedBooks,
  };
}

export async function importBackupJSON(payload, { mode = "merge" } = {}) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.books)) {
    throw new Error("Backup non valido o schema non supportato.");
  }

  const currentLocs = await getLocations();
  const incomingLocs = Array.isArray(payload.locations) ? payload.locations : [];
  const locSet = new Set([...currentLocs, ...incomingLocs].map((x) => (x || "").trim()).filter(Boolean));
  await setLocations(Array.from(locSet));

  const currentBooks = await listBooks();
  const currentMap = new Map(currentBooks.map((b) => [b.id, b]));

  for (const inb of payload.books) {
    const coverBlob = inb.coverDataUrl ? await dataURLToBlob(inb.coverDataUrl) : null;
    const { coverDataUrl, ...rest } = inb;

    const existing = currentMap.get(rest.id);
    if (mode === "merge" && existing) {
      const exU = existing.updatedAt || 0;
      const inU = rest.updatedAt || 0;
      if (inU <= exU) continue;
    }
    await upsertBook({ ...rest, coverBlob });
  }
}
