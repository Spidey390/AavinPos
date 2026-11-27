import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { createFinancialService } from './financial.js';

if ((process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) && process.env.FUNCTIONS_EMULATOR !== 'true') throw new Error('Production Functions must not use emulator endpoints.');
initializeApp();
const service = createFinancialService(getFirestore(), { allowRefunds: process.env.ENABLE_RECONCILED_REFUNDS === 'true' });
const origins = (process.env.POS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const options = { region: 'asia-south1', maxInstances: 10, concurrency: 1, timeoutSeconds: 60, memory: '256MiB', cors: process.env.FUNCTIONS_EMULATOR === 'true' ? [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] : origins };
const callable = name => onCall(options, async request => {
  try {
    if (Buffer.byteLength(JSON.stringify(request.data ?? null)) > 512000) throw new HttpsError('invalid-argument', 'Request is too large.');
    return await service[name](request);
  }
  catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('financial-operation-failed', { operation: name });
    throw new HttpsError('internal', 'The operation could not be completed. Retry using the same operation ID.');
  }
});
export const checkout = callable('checkout');
export const initializeWorkspace = callable('initializeWorkspace');

export const saveCustomer = callable('saveCustomer');
export const archiveCustomer = callable('archiveCustomer');

export const recordPayment = callable('recordPayment');

export const refund = callable('refund');
