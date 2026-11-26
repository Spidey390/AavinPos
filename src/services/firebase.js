import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore';
import { app, useEmulators, emulatorPorts } from './firebaseApp';

export const firestore = initializeFirestore(app, { ignoreUndefinedProperties: true });

if (useEmulators) connectFirestoreEmulator(firestore, '127.0.0.1', emulatorPorts.firestore);
