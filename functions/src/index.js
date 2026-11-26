import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { createFinancialService } from './financial.js';

initializeApp();
const service = createFinancialService(getFirestore());
const origins = (process.env.POS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const options = { region: 'asia-south1', maxInstances: 10, timeoutSeconds: 60, memory: '256MiB', cors: process.env.FUNCTIONS_EMULATOR === 'true' ? [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] : origins };
const callable = name => onCall(options, async request => {
  try { return await service[name](request); }
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
