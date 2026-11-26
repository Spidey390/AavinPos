import React, { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { firestore } from '../../services/firebase';
import { AppProvider } from '../../context/AppContext';
import App from '../../App';
import { AccountMessage } from './OperatorGate';

export default function OperatorWorkspace({ user, onSignOut }) {
  const [operator, setOperator] = useState(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let unsub = () => {};
    const timeout = setTimeout(() => {
      setOperator(null);
      setError('Could not verify operator access. Check your connection and sign in again.');
    }, 15000);
    try {
      unsub = onSnapshot(doc(firestore, 'operators', user.uid), { includeMetadataChanges: true }, snapshot => {
        // Do not authorize from a stale cached profile or an uncommitted write.
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
          setOperator(undefined);
          return;
        }
        clearTimeout(timeout);
        setError('');
        setOperator(snapshot.exists() ? snapshot.data() : null);
      }, () => {
        clearTimeout(timeout);
        setOperator(null);
        setError('The operator profile could not be loaded. Check your connection and sign in again.');
      });
    } catch {
      clearTimeout(timeout);
      setOperator(null);
      setError('The operator profile could not be loaded. Sign in again.');
    }
    return () => { clearTimeout(timeout); unsub(); };
  }, [user.uid]);

  if (operator?.active && ['owner', 'staff'].includes(operator.role)) {
    return (
      <AppProvider key={operator.role} operator={{ ...operator, uid: user.uid, email: user.email }} signOut={onSignOut}>
        <App />
      </AppProvider>
    );
  }

  return (
    <AccountMessage>
      {operator === undefined ? <p role="status" className="mt-4">Checking operator access…</p> : (
        <>
          <p role="alert" className="mt-4 text-sm">{error || 'This account has no active POS access. Contact the owner.'}</p>
          <button type="button" className="mt-4 underline" onClick={onSignOut}>Sign out</button>
        </>
      )}
    </AccountMessage>
  );
}
