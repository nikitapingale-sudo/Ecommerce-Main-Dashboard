import React, { useState, useRef, useEffect } from 'react';
import { Send, X, Square } from 'lucide-react';
import { answer, buildContext, SUGGESTIONS, recommendations } from '../utils/ecomwallah';
import { fmt, pct, chatLLMStream } from '../utils/dataEngine';

export default function ChatWidget({ data }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState([]);
  const [busy, setBusy] = useState(false);     // waiting on the LLM
  const [status, setStatus] = useState('');     // live progress text while thinking
  const [llmDown, setLlmDown] = useState(false); // backend LLM unavailable -> local mode
  const endRef = useRef(null);
  const abortRef = useRef(null);                  // aborts the in-flight stream
  const m = (data && data.metrics) || {};

  // Seed the welcome message once data is available / panel first opens.
  useEffect(() => {
    if (open && msgs.length === 0) {
      const top = recommendations(data)[0];
      setMsgs([{ role:'bot', text:
        `👋 Hi, I'm EcomWallah — your live data assistant.\n\n${(m.orders||0).toLocaleString()} orders · ${fmt(m.rev)} revenue · delivery ${pct(m.delivRate)} · RTO ${pct(m.rtoRate)}.\n🔔 Most urgent: ${top ? `${top.icon} ${top.title}` : 'nothing critical'}.\n\nAsk me anything 👇` }]);
    }
  }, [open]); // eslint-disable-line

  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }); }, [msgs, open, busy]);

  // Replace the last message (always the streaming bot bubble) with `patch`.
  const patchLast = (patch) => setMsgs(ms => {
    const c = [...ms];
    c[c.length - 1] = { ...c[c.length - 1], ...patch };
    return c;
  });

  const ask = async (q) => {
    const text = (q ?? input).trim();
    if (!text || busy) return;

    // Snapshot the history to send (before adding this turn), then show the user msg.
    const history = msgs.slice(-8);
    setMsgs(ms => [...ms, { role:'user', text }]);
    setInput('');

    // If we already know the LLM is down, answer locally and skip the round-trip.
    if (llmDown) {
      setMsgs(ms => [...ms, { role:'bot', text: answer(text, data) }]);
      return;
    }

    setBusy(true);
    setStatus('');
    const controller = new AbortController();
    abortRef.current = controller;
    // Add an empty bot bubble we fill as tokens stream in.
    setMsgs(ms => [...ms, { role:'bot', text:'', streaming:true }]);
    try {
      await chatLLMStream({
        question: text, context: buildContext(data), history, signal: controller.signal,
        onStatus: (s) => setStatus(s),
        onDelta: (full) => { setStatus(''); patchLast({ text: full, streaming:true }); },
      });
      patchLast({ streaming:false });
    } catch (err) {
      if (err.name === 'AbortError') {
        // User pressed stop — keep whatever streamed; note it if nothing did.
        setMsgs(ms => {
          const c = [...ms]; const last = c[c.length-1];
          c[c.length-1] = last?.role==='bot' && !last.text
            ? { role:'bot', text:'⏹ Stopped.' }
            : { ...last, streaming:false };
          return c;
        });
      } else if (err.status === 503) {
        setLlmDown(true);                                          // no key -> offline mode
        patchLast({ text: answer(text, data), streaming:false });
      } else if (err.status === 429) {
        patchLast({ text: `⏳ ${err.message}`, streaming:false }); // rate limited — be explicit
      } else if (err.partial) {
        patchLast({ text: err.partial, streaming:false });         // keep what streamed
      } else {
        patchLast({ text: answer(text, data), streaming:false });  // rule-based fallback
      }
    } finally {
      setBusy(false);
      setStatus('');
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <>
      {/* Floating button */}
      <button onClick={() => setOpen(o => !o)} title="Ask EcomWallah" style={{
        position:'fixed', right:22, bottom:22, zIndex:9600, width:58, height:58, borderRadius:'50%',
        background:'var(--accent-grad)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center',
        boxShadow:'0 8px 24px rgba(120,60,30,.4)', fontSize:24 }}>
        {open ? <X size={24}/> : '🤖'}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{ position:'fixed', right:22, bottom:92, zIndex:9600, width:390, maxWidth:'92vw',
                      height:560, maxHeight:'76vh', background:'var(--surface)', border:'1px solid var(--border)',
                      borderRadius:18, boxShadow:'var(--shadow2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          {/* Header */}
          <div style={{ background:'var(--accent-grad)', color:'#fff', padding:'13px 16px', display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:34, height:34, borderRadius:10, background:'rgba(255,255,255,.2)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🤖</div>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:800, fontSize:14, fontFamily:'var(--serif)' }}>EcomWallah</div>
              <div style={{ fontSize:11, opacity:.9 }}>{llmDown ? 'Live data assistant · offline mode' : 'AI data assistant'}</div>
            </div>
            <button onClick={() => setOpen(false)} style={{ background:'rgba(255,255,255,.18)', borderRadius:8, padding:5, color:'#fff', display:'flex' }}><X size={15}/></button>
          </div>

          {/* Messages */}
          <div style={{ flex:1, overflowY:'auto', padding:'12px', display:'flex', flexDirection:'column', gap:10 }}>
            {msgs.map((msg, i) => (
              // Skip the empty streaming placeholder — the "thinking" bubble covers it.
              (msg.role==='bot' && !msg.text) ? null : (
              <div key={i} style={{ display:'flex', justifyContent: msg.role==='user' ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth:'85%', whiteSpace:'pre-wrap', lineHeight:1.5, fontSize:12.5, padding:'9px 12px', borderRadius:12,
                              background: msg.role==='user' ? 'var(--accent)' : 'var(--surface2)',
                              color: msg.role==='user' ? '#fff' : 'var(--text)',
                              border: msg.role==='user' ? 'none' : '1px solid var(--border)' }}>
                  {msg.text}{msg.streaming && <span className="ew-cursor">▋</span>}
                </div>
              </div>
              )
            ))}
            {busy && !msgs[msgs.length-1]?.text && (
              <div style={{ display:'flex', justifyContent:'flex-start' }}>
                <div style={{ fontSize:12.5, padding:'9px 12px', borderRadius:12, background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text2)' }}>
                  {status ? status : <>EcomWallah is thinking<span className="ew-dots">…</span></>}
                </div>
              </div>
            )}
            {msgs.length <= 1 && !busy && (
              <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginTop:4 }}>
                {SUGGESTIONS.slice(0, 6).map(s => (
                  <button key={s} onClick={() => ask(s)} style={{ fontSize:11, padding:'5px 10px', borderRadius:16, background:'var(--surface)', border:'1px solid var(--border)', color:'var(--text2)' }}>{s}</button>
                ))}
              </div>
            )}
            <div ref={endRef}/>
          </div>

          {/* Input */}
          <div style={{ display:'flex', gap:8, padding:'10px', borderTop:'1px solid var(--border)' }}>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask(); }}
              disabled={busy}
              placeholder={busy ? 'Thinking…' : 'Ask about revenue, SKUs, coupons…'}
              style={{ flex:1, padding:'10px 12px', fontSize:13, color:'var(--text)', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:10, outline:'none', opacity: busy ? .7 : 1 }}/>
            {busy ? (
              <button onClick={stop} title="Stop generating"
                style={{ width:40, borderRadius:10, background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}><Square size={14} fill="currentColor"/></button>
            ) : (
              <button onClick={() => ask()} title="Send"
                style={{ width:40, borderRadius:10, background:'var(--accent)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}><Send size={16}/></button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
