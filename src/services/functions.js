import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { auth } from './auth';
import { runPaymentIntent } from '../domain/paymentIntent';
import { app, useEmulators, emulatorPorts } from './firebaseApp';

const functions = getFunctions(app, useEmulators ? 'asia-south1' : `${window.location.origin}/api`);
if (useEmulators) connectFunctionsEmulator(functions, '127.0.0.1', emulatorPorts.functions);
export const callFinancial = async (name, data) => (await httpsCallable(functions, name, { timeout: 60000 })(data)).data;

export const callFinancialOnce = (name, data) => runPaymentIntent({ storage: sessionStorage, uid: auth.currentUser?.uid, scope: `${name}:${data.workspace}:${data.customerId ?? data.orderId ?? ''}`, payload: { name, data }, call: idempotencyKey => callFinancial(name, { ...data, idempotencyKey }) });
