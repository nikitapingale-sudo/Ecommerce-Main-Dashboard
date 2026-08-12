import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// ─────────────────────────────────────────────────────────────────────────────
//  Dashboard is currently OPEN (no login gate) — restored so the team isn't
//  blocked while the backend/tunnel work is stabilised.
//
//  The login module IS built and ready (LoginPage.jsx + auth endpoints with
//  hashed passwords). To switch it back on, replace the render below with the
//  gated version:
//
//    import { useState } from 'react'
//    import LoginPage from './components/LoginPage.jsx'
//    import { getSession, clearSession } from './utils/dataEngine'
//    function Root() {
//      const [s, setS] = useState(() => getSession());
//      return s
//        ? <App userEmail={s.email} onLogout={() => { clearSession(); setS(null); }} />
//        : <LoginPage onAuth={() => setS(getSession())} />;
//    }
//    ...render(<Root/>)
// ─────────────────────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App userEmail="PW Orders" onLogout={() => window.location.reload()} />
  </React.StrictMode>
)
