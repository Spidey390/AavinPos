import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

const OperatorGate = lazy(() => import('./components/auth/OperatorGate'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<p role="status" className="p-6 text-white">Opening POS…</p>}><OperatorGate /></Suspense>
    </ErrorBoundary>
  </React.StrictMode>
);
