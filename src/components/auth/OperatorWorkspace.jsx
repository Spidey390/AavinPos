import React, { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { firestore } from '../../services/firebase';
import { AppProvider } from '../../context/AppContext';
import App from '../../App';
import { AccountMessage } from './OperatorGate';

export default function OperatorWorkspace({ user, onSignOut }) {
  const isOwnerEmail = Boolean(user.email?.toLowerCase().includes('aavinkvp'));
  const [operator, setOperator] = useState(isOwnerEmail ? {
    name: 'Owner',
    email: user.email,
    role: 'owner',
    active: true
  } : undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let unsub = () => {};
    try {
      unsub = onSnapshot(doc(firestore, 'operators', user.uid), async snapshot => {
        if (!snapshot.exists() && isOwnerEmail) {
          try {
            await setDoc(doc(firestore, 'operators', user.uid), {
              name: 'Owner',
              email: user.email,
              role: 'owner',
              active: true
            });
            return;
          } catch (err) {
            console.warn('Auto-create owner operator doc skipped:', err);
          }
        }
        if (snapshot.exists()) {
          setOperator(snapshot.data());
        } else if (isOwnerEmail) {
          setOperator({ name: 'Owner', email: user.email, role: 'owner', active: true });
        } else {
          setOperator(null);
        }
      }, (err) => {
        console.warn('Operator snapshot error:', err);
        if (isOwnerEmail) {
          setOperator({ name: 'Owner', email: user.email, role: 'owner', active: true });
        } else {
          setOperator(null);
          setError('The operator profile could not be loaded. Check your connection and sign in again.');
        }
      });
    } catch (err) {
      if (isOwnerEmail) {
        setOperator({ name: 'Owner', email: user.email, role: 'owner', active: true });
      }
    }
    return unsub;
  }, [user.uid, user.email, isOwnerEmail]);

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
