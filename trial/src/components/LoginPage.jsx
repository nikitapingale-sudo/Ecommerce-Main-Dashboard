import React, { useState } from 'react';
import { Mail, Lock, ArrowRight, Loader2, ShoppingCart, TrendingUp, Package, KeyRound } from 'lucide-react';
import { authRegister, authLogin, authForgot, authReset, saveSession } from '../utils/dataEngine';

const MIN_PW = 8;  // keep in sync with MIN_PW_LEN in scripts/api.py

export default function LoginPage({ onAuth }) {
  const [step, setStep] = useState('form');     // 'form' | 'reset'
  const [mode, setMode] = useState('login');    // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // On success the backend returns { token, email, expiresAt } — persist it and
  // hand control back to <Root>, which re-reads the session and mounts the app.
  const finish = (res) => { saveSession(res); onAuth(); };

  const requestReset = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !em.includes('@')) { setError('Enter your email above first.'); return; }
    setBusy(true); setError(''); setNote('');
    try {
      const res = await authForgot(em);
      setNote(res.emailed
        ? `If ${em} has an account, we've emailed a 6-digit reset code. Enter it below.`
        : (res.note || 'If that email has an account, a reset code has been sent.'));
      setStep('reset');
    } catch (err) { setError(err.message || 'Could not start reset.'); }
    finally { setBusy(false); }
  };

  const submitReset = async (e) => {
    e.preventDefault();
    if (!code.trim()) { setError('Enter the reset code.'); return; }
    if (password.length < MIN_PW) { setError(`New password must be at least ${MIN_PW} characters.`); return; }
    setBusy(true); setError('');
    try {
      const res = await authReset(email.trim().toLowerCase(), code.trim(), password);
      finish(res);
    } catch (err) { setError(err.message || 'Reset failed.'); }
    finally { setBusy(false); }
  };

  const submitCreds = async (e) => {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!em || !em.includes('@')) { setError('Enter a valid email address.'); return; }
    if (password.length < MIN_PW) { setError(`Password must be at least ${MIN_PW} characters.`); return; }
    setBusy(true); setError('');
    try {
      const fn = mode === 'signup' ? authRegister : authLogin;
      const res = await fn(em, password);
      finish(res);
    } catch (err) { setError(err.message || (mode === 'signup' ? 'Sign up failed.' : 'Login failed.')); }
    finally { setBusy(false); }
  };

  const field = {
    width: '100%', padding: '12px 14px 12px 42px', fontSize: 14, color: 'var(--text)',
    background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 10, outline: 'none',
  };
  const iconWrap = { position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' };

  const switchMode = (m) => { setMode(m); setError(''); };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', fontFamily: 'var(--font)' }}>
      {/* ── Brand panel ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                    padding: '48px', color: '#fff', position: 'relative', overflow: 'hidden',
                    background: 'linear-gradient(150deg,#4f46e5 0%,#6d28d9 55%,#7c3aed 100%)' }}
           className="login-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>📦</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>PW Orders</div>
            <div style={{ fontSize: 12, opacity: .85 }}>Intelligence Hub</div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.2, maxWidth: 460 }}>
            Your orders, revenue & fulfilment — all in one place.
          </div>
          <div style={{ fontSize: 15, opacity: .9, marginTop: 14, maxWidth: 440 }}>
            Real-time analytics for the e-commerce team across every channel, SKU and region.
          </div>
          <div style={{ display: 'flex', gap: 22, marginTop: 34 }}>
            {[[ShoppingCart, 'Orders'], [TrendingUp, 'Revenue'], [Package, 'Catalog']].map(([Ic, t], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: .95 }}>
                <Ic size={18}/> {t}
              </div>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 12, opacity: .7 }}>© PhysicsWallah · Data Team</div>
        <div style={{ position: 'absolute', right: -80, top: -80, width: 280, height: 280, borderRadius: '50%', background: 'rgba(255,255,255,.08)' }}/>
        <div style={{ position: 'absolute', right: 40, bottom: -60, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,.07)' }}/>
      </div>

      {/* ── Form panel ── */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>
            {step === 'reset' ? 'Reset your password' : mode === 'signup' ? 'Create your account' : 'Welcome back'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 6, marginBottom: 22 }}>
            {step === 'reset'
              ? (note || <>Enter the reset code sent to <b style={{ color: 'var(--text2)' }}>{email}</b> and choose a new password.</>)
              : mode === 'signup'
                ? 'Sign up with your work email and a strong password.'
                : 'Sign in with your work email.'}
          </div>

          {step === 'reset' ? (
            <form onSubmit={submitReset}>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <span style={iconWrap}><KeyRound size={16}/></span>
                <input autoFocus value={code} onChange={e => setCode(e.target.value)} placeholder="6-digit reset code" style={field}/>
              </div>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <span style={iconWrap}><Lock size={16}/></span>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={`New password (min ${MIN_PW} chars)`} style={field}/>
              </div>
              <Submit busy={busy} label="Reset & sign in"/>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:12 }}>
                <button type="button" onClick={requestReset} disabled={busy} style={{ background:'transparent', color:'var(--accent)', fontSize:12.5, fontWeight:600 }}>Resend code</button>
                <button type="button" onClick={() => { setStep('form'); setCode(''); setPassword(''); setError(''); setNote(''); }} style={{ background:'transparent', color:'var(--text3)', fontSize:12.5 }}>← Back</button>
              </div>
            </form>
          ) : (
            <>
              {/* Sign in / Create account tabs — the client chooses; the server
                  never discloses whether an account exists (report F-22). */}
              <div style={{ display:'flex', gap:4, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:10, padding:4, marginBottom:18 }}>
                {[['login','Sign in'], ['signup','Create account']].map(([m, lbl]) => (
                  <button key={m} type="button" onClick={() => switchMode(m)} style={{
                    flex:1, padding:'8px 10px', borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer', border:'none',
                    background: mode===m ? 'var(--surface)' : 'transparent',
                    boxShadow: mode===m ? 'var(--shadow)' : 'none',
                    color: mode===m ? 'var(--text)' : 'var(--text3)' }}>{lbl}</button>
                ))}
              </div>
              <form onSubmit={submitCreds}>
                <div style={{ position: 'relative', marginBottom: 14 }}>
                  <span style={iconWrap}><Mail size={16}/></span>
                  <input autoFocus type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" style={field}/>
                </div>
                <div style={{ position: 'relative', marginBottom: 14 }}>
                  <span style={iconWrap}><Lock size={16}/></span>
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                         placeholder={mode === 'signup' ? `Set a password (min ${MIN_PW} chars)` : 'Your password'} style={field}/>
                </div>
                <Submit busy={busy} label={mode === 'signup' ? 'Create account & sign in' : 'Sign in'}/>
                {mode === 'login' && (
                  <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 12 }}>
                    <button type="button" onClick={requestReset} disabled={busy}
                            style={{ background: 'transparent', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
                      Forgot password?
                    </button>
                  </div>
                )}
              </form>
            </>
          )}

          {error && <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--red)', background: 'var(--red-bg)', padding: '9px 12px', borderRadius: 9 }}>{error}</div>}
        </div>
      </div>

      <style>{`@media (max-width: 820px){ .login-brand{ display:none !important; } }`}</style>
    </div>
  );
}

function Submit({ busy, label }) {
  return (
    <button type="submit" disabled={busy} style={{
      width: '100%', padding: '12px', borderRadius: 10, border: 'none', cursor: busy ? 'default' : 'pointer',
      background: 'var(--accent-grad)', color: '#fff', fontSize: 14, fontWeight: 700,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      boxShadow: '0 4px 14px rgba(79,70,229,.35)', opacity: busy ? .8 : 1,
    }}>
      {busy ? <Loader2 size={16} className="spin"/> : <>{label} <ArrowRight size={16}/></>}
      <style>{`.spin{animation:pwspin .8s linear infinite}@keyframes pwspin{to{transform:rotate(360deg)}}`}</style>
    </button>
  );
}
