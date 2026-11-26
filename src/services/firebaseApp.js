import { initializeApp } from 'firebase/app';
import { resolveFirebaseConfig } from '../domain/firebaseConfig';

export const useEmulators = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';
export const emulatorPorts = {
  auth: Number(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || 9099),
  firestore: Number(import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || 8080)
};

export const app = initializeApp(resolveFirebaseConfig(import.meta.env, import.meta.env.DEV));
