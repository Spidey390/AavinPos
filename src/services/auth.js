import { browserSessionPersistence, connectAuthEmulator, initializeAuth } from 'firebase/auth';
import { app, useEmulators, emulatorPorts } from './firebaseApp';

// Shared terminals must not retain a refresh token after the browser session.
export const auth = initializeAuth(app, { persistence: browserSessionPersistence });
if (useEmulators) connectAuthEmulator(auth, `http://127.0.0.1:${emulatorPorts.auth}`, { disableWarnings: true });
