import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { app, useEmulators, emulatorPorts } from './firebaseApp';

const functions = getFunctions(app, useEmulators ? 'asia-south1' : `${window.location.origin}/api`);
if (useEmulators) connectFunctionsEmulator(functions, '127.0.0.1', emulatorPorts.functions);
export const callFinancial = async (name, data) => (await httpsCallable(functions, name, { timeout: 60000 })(data)).data;
