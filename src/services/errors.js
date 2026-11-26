export function reportError(event, error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9/_-]{1,80}$/i.test(error.code) ? error.code : 'unexpected-error';
  // Keep credentials, customer records, error messages and stack traces out of logs.
  console.error(JSON.stringify({ event, code }));
}

export function publicError(error, fallback = 'The change could not be saved. Try again.') {
  if (['functions/invalid-argument', 'functions/failed-precondition', 'functions/already-exists', 'functions/not-found'].includes(error?.code)) {
    return typeof error.message === 'string' ? error.message.slice(0, 300) : fallback;
  }
  if (error?.code) return ({
    'permission-denied': 'Access denied. Check your operator permissions and try again.',
    'unavailable': 'The service is unavailable. Check your connection and retry.',
    'resource-exhausted': 'The service is busy. Wait a moment and try again.'
  })[error.code] || fallback;
  if (error instanceof SyntaxError) return 'Choose a valid JSON backup file.';
  return error instanceof Error ? error.message : fallback;
}
