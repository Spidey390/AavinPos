import { newId } from './ids.js';

const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const definitelyRejected = new Set(['functions/invalid-argument', 'functions/failed-precondition', 'functions/permission-denied', 'functions/unauthenticated', 'functions/not-found', 'functions/resource-exhausted']);

// Keep one unconfirmed intent per operator/customer/action. Editing a form after
// an uncertain response must not silently produce a second financial operation.
export async function runPaymentIntent({ storage, uid, scope = 'payment', payload, call }) {
  if (!uid) throw new Error('Sign in before recording a payment.');
  const key = `aavin-pending-financial-v2:${uid}:${await digest(scope)}`;
  const payloadHash = await digest(JSON.stringify(payload));
  let intent;
  try {
    const saved = storage.getItem(key);
    intent = saved ? JSON.parse(saved) : { operation: newId(), payloadHash };
    if (typeof intent.operation !== 'string' || typeof intent.payloadHash !== 'string') throw new Error('Invalid saved intent.');
  } catch (error) {
    throw new Error('Enable session storage before recording a payment so retries remain safe.', { cause: error });
  }
  if (intent.payloadHash !== payloadHash) throw new Error('An earlier payment outcome is uncertain. Retry its original details or ask the owner to verify its receipt before starting another payment.');
  try { storage.setItem(key, JSON.stringify(intent)); }
  catch (error) { throw new Error('Payment was not submitted because its retry ID could not be saved.', { cause: error }); }
  try {
    const result = await call(intent.operation);
    storage.removeItem(key);
    return result;
  } catch (error) {
    if (definitelyRejected.has(error.code)) storage.removeItem(key);
    throw error;
  }
}
