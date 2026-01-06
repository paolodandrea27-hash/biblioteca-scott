import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Configurazione Firebase
const firebaseConfig = {
  apiKey: "AIzaSyCv0zpv-wM6dx5uHcgco_O7D4S_NE024wE",
  authDomain: "biblioteca-scott.firebaseapp.com",
  projectId: "biblioteca-scott",
  storageBucket: "biblioteca-scott.firebasestorage.app",
  messagingSenderId: "1006522361048",
  appId: "1:1006522361048:web:e5bec210732c768f0ee3ad",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
