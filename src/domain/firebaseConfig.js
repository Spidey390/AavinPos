export const firebaseEnvironmentNames = {
  apiKey: 'VITE_FIREBASE_API_KEY', authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID', storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID', appId: 'VITE_FIREBASE_APP_ID',
  measurementId: 'VITE_FIREBASE_MEASUREMENT_ID'
};

export function resolveFirebaseConfig(env, development = false) {
  const known = [...Object.values(firebaseEnvironmentNames), 'VITE_USE_FIREBASE_EMULATORS',
    'VITE_FIREBASE_AUTH_EMULATOR_PORT', 'VITE_FIREBASE_FIRESTORE_EMULATOR_PORT', 'VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT'];
  const unknown = Object.keys(env).filter(key => key.startsWith('VITE_') && !known.includes(key));
  if (unknown.length) throw new Error(`Unreviewed public environment variables: ${unknown.join(', ')}`);
  const emulator = env.VITE_USE_FIREBASE_EMULATORS === 'true';
  if (emulator && !development) throw new Error('Production builds must not enable Firebase emulators.');
  if (emulator && ['VITE_FIREBASE_AUTH_EMULATOR_PORT', 'VITE_FIREBASE_FIRESTORE_EMULATOR_PORT', 'VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT'].some(name =>
    env[name] && (!/^\d+$/.test(env[name]) || Number(env[name]) < 1024 || Number(env[name]) > 65535))) {
    throw new Error('Emulator ports must be integers from 1024 to 65535.');
  }
  const config = Object.fromEntries(Object.entries(firebaseEnvironmentNames).map(([key, name]) => [key, env[name]]));
  if (emulator) return {
    ...config, apiKey: 'demo-api-key', authDomain: 'demo-billingapp.firebaseapp.com', projectId: 'demo-billingapp',
    storageBucket: 'demo-billingapp.firebasestorage.app', messagingSenderId: '000000000000', appId: '1:000000000000:web:000000000000'
  };
  const missing = ['apiKey', 'projectId', 'authDomain', 'appId'].filter(key =>
    !config[key]?.trim() || /^(?:your_|replace_)/i.test(config[key]));
  if (missing.length) throw new Error(`Missing Firebase configuration: ${missing.map(key => firebaseEnvironmentNames[key]).join(', ')}`);
  if (!development && config.projectId.startsWith('demo-')) throw new Error('Production builds require a non-demo Firebase project.');
  return config;
}
