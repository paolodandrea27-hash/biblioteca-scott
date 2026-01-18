import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { db } from "./firebase";

export const LIBRARY_ID = "biblioteca-scott";

function booksCol() {
  return collection(db, "libraries", LIBRARY_ID, "books");
}
function metaDoc() {
  return doc(db, "libraries", LIBRARY_ID, "meta", "settings");
}

export function makeId() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

export async function listBooks() {
  const snap = await getDocs(booksCol());
  const books = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  books.sort(
    (a, b) =>
      (a.authorLast || "").localeCompare(b.authorLast || "", "it") ||
      (a.title || "").localeCompare(b.title || "", "it")
  );
  return books;
}

export async function upsertBook(book) {
  const ref = doc(db, "libraries", LIBRARY_ID, "books", book.id);
  await setDoc(ref, book, { merge: true });
}

export async function deleteBook(id) {
  const ref = doc(db, "libraries", LIBRARY_ID, "books", id);
  await deleteDoc(ref);
}

export async function getLocations() {
  const ref = metaDoc();
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const defaults = ["salone", "camera matrimoniale", "camera Niki", "camera Francesco", "camera Cecilia", "studio"];
    await setDoc(ref, { locations: defaults }, { merge: true });
    return defaults;
  }
  const data = snap.data();
  const locs = Array.isArray(data.locations) ? data.locations : [];
  return locs.length ? locs : ["salone"];
}

export async function setLocations(locs) {
  const ref = metaDoc();
  await setDoc(ref, { locations: locs }, { merge: true });
}

export async function getCategories() {
  const ref = metaDoc();
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const defaults = [
      "Narrativa",
      "Saggistica",
      "Classici",
      "Poesia",
      "Teatro",
      "Altro",
    ];
    await setDoc(ref, { categories: defaults }, { merge: true });
    return defaults;
  }
  const data = snap.data();
  const cats = Array.isArray(data.categories) ? data.categories : [];
  return cats.length ? cats : ["Altro"];
}

export async function setCategories(categories) {
  const ref = metaDoc();
  await setDoc(ref, { categories }, { merge: true });
}

export async function exportBackupJSON() {
  const books = await listBooks();
  const locations = await getLocations();
  const categories = await getCategories();
  return { version: 3, exportedAt: Date.now(), libraryId: LIBRARY_ID, locations, categories, books };
}

export async function importBackupJSON(payload, { mode = "merge" } = {}) {
  const incoming = payload?.books || [];
  const incomingLocs = payload?.locations || [];
  const incomingCats = payload?.categories || [];

  if (incomingLocs.length) await setLocations(incomingLocs);
  if (incomingCats.length) await setCategories(incomingCats);

  if (mode === "replace") {
    const existing = await listBooks();
    for (const b of existing) await deleteBook(b.id);
  }

  for (const b of incoming) {
    if (!b.id) continue;
    await upsertBook(b);
  }
}

export async function clearAllData() {
  const existing = await listBooks();
  for (const b of existing) await deleteBook(b.id);
  await setLocations(["salone", "camera matrimoniale", "camera Niki", "camera Francesco", "camera Cecilia", "studio"]);
  await setCategories(["Narrativa", "Saggistica", "Classici", "Poesia", "Teatro", "Altro"]);
}

export async function blobToObjectURL(valueOrNull) {
  return valueOrNull || null;
}
