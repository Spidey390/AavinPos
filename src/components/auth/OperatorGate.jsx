import React, { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '../../services/auth';
import { clearCounterDrafts } from '../../domain/drafts';
import { sanitizeText } from '../../domain/sanitize';

const defaultTitle = 'Aavin POS';
const BrandTitle = React.createContext(defaultTitle);
const Workspace = lazy(() => import('./OperatorWorkspace'));

export function AccountMessage({ children }) {
  return (
    <main className="min-h-[100dvh] grid place-items-center bg-[#0d1117] app-gutters py-4">
      <section className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#171c26] p-6 text-white">
        <h1 className="text-xl font-bold">{React.useContext(BrandTitle)}</h1>
        {children}
      </section>
    </main>
  );
}

export default function OperatorGate() {
  const [title, setTitle] = useState(defaultTitle);

  useEffect(() => {
    let active = true;
    let unsubscribe;
    import('../../services/branding').then(({ watchBrandName }) => {
      if (!active) return;
      unsubscribe = watchBrandName(brandName => {
        const name = brandName?.trim();
        if (!name) {
          setTitle(defaultTitle);
        } else {
          setTitle(/\bpos$/i.test(name) ? name : `${name} POS`);
        }
      });
    }).catch(() => { if (active) setTitle(defaultTitle); });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return <BrandTitle.Provider value={title}><SignIn /></BrandTitle.Provider>;
}

function SignIn() {
  const [user, setUser] = useState(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const failedAttempts = useRef(0);
  const cooldownTimer = useRef(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    if (cooldown > 0) {
      cooldownTimer.current = setInterval(() => {
        setCooldown(c => {
          if (c <= 1) {
            clearInterval(cooldownTimer.current);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
      return () => clearInterval(cooldownTimer.current);
    }
  }, [cooldown]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending || cooldown > 0) return;
    const form = new FormData(event.currentTarget);
    let email = sanitizeText(form.get('email'), 120);
    if (email && !email.includes('@') && email.includes('gmail.com')) {
      email = email.replace('gmail.com', '@gmail.com');
    }
    const password = form.get('password') || '';
    if (!email || !password) return;

    setPending(true);
    setError('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
      failedAttempts.current = 0;
    } catch (failure) {
      failedAttempts.current += 1;
      if (failedAttempts.current >= 5) {
        setCooldown(30);
        setError('Too many failed attempts. Access rate-limited for 30 seconds.');
      } else {
        const errorMessages = {
          'auth/too-many-requests': 'Too many failed attempts. Access temporarily locked. Try again later.',
          'auth/user-disabled': 'This operator account has been disabled. Contact the owner.',
          'auth/network-request-failed': 'Could not reach Firebase. Check your connection and try again.',
          'auth/configuration-not-found': 'Firebase Authentication is not enabled for project aavin-81398 yet. Enable Email/Password in Firebase Console (Authentication > Sign-in method).'
        };
        setError(errorMessages[failure.code] || 'Sign-in failed. Check your email and password.');
      }
    } finally {
      setPending(false);
    }
  }

  const loading = <AccountMessage><p role="status" className="mt-4">Checking your operator account…</p></AccountMessage>;
  if (user === undefined) return loading;

  if (user) {
    return (
      <Suspense fallback={loading}>
        <Workspace key={user.uid} user={user} onSignOut={async () => {
          const uid = user.uid;
          await signOut(auth);
          try { clearCounterDrafts(sessionStorage, uid); } catch { /* Storage may be disabled. */ }
        }} />
      </Suspense>
    );
  }

  return (
    <AccountMessage>
          <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
            <label className="block text-sm">Email
              <input name="email" type="email" required maxLength={120} autoComplete="username" disabled={cooldown > 0}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-[#121620] p-2 disabled:opacity-50" />
            </label>
            <label className="block text-sm">Password
              <input name="password" type="password" required maxLength={128} autoComplete="current-password" disabled={cooldown > 0}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-[#121620] p-2 disabled:opacity-50" />
            </label>
            {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
            {cooldown > 0 && <p className="text-xs text-amber-300">Rate limit active: retry in {cooldown}s</p>}
            <button type="submit" disabled={pending || cooldown > 0}
              className="w-full rounded-lg bg-orange-700 p-2 font-semibold disabled:opacity-60">
              {pending ? 'Signing in…' : cooldown > 0 ? `Wait ${cooldown}s` : 'Sign in'}
            </button>
          </form>
    </AccountMessage>
  );
}
