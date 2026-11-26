import React from 'react';
import { reportError } from '../services/errors';

export default class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { reportError('application-render-failed', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="min-h-[100dvh] grid place-items-center bg-[#0d1117] p-6 text-white">
      <section className="max-w-sm space-y-4" role="alert">
        <h1 className="text-xl font-bold">The POS could not open</h1>
        <p>Reload to try again. If the problem continues, contact the owner.</p>
        <button className="rounded-lg bg-orange-700 px-4 py-2" onClick={() => window.location.reload()}>Reload</button>
      </section>
    </main>;
  }
}
