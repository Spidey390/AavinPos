import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { createFinancialService } from './financial.js';
import { createStaffService } from './staff.js';
export const callableNames = Object.freeze(['checkout', 'initializeWorkspace', 'saveCustomer', 'archiveCustomer', 'recordPayment', 'refund', 'recordStaffLogin', 'getStaffSummary']);
export function createCallableHandlers(db, { allowRefunds = false, cors = [] } = {}) {
  const service = { ...createFinancialService(db, { allowRefunds }), ...createStaffService(db) };
  return Object.fromEntries(callableNames.map(name => [name, onCall({ region: 'asia-south1', maxInstances: 10, concurrency: 1, timeoutSeconds: 60, memory: '256MiB', cors }, async request => {
    try {
      if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
      if (Buffer.byteLength(JSON.stringify(request.data ?? null)) > 512000) throw new HttpsError('invalid-argument', 'Request is too large.');
      if (request.auth && !['recordStaffLogin', 'getStaffSummary'].includes(name)) await service.recordStaffLogin({ auth: request.auth, data: {} });
      return await service[name](request);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error('financial-operation-failed', { operation: name });
      throw new HttpsError('internal', 'The operation could not be completed. Retry using the same operation ID.');
    }
  })]));
}
