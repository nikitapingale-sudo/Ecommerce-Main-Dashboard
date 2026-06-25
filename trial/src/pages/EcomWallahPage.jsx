import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { answer, SUGGESTIONS, recommendations } from '../utils/ecomwallah';
import { fmt, pct } from '../utils/dataEngine';

export default function EcomWallahPage({ data }) {
  const m = data.metrics || {};
  const [msgs, setMsgs] = useState(() => {
    const top = recommendations(data)[0];
    return [{
      role: 'bot',
      text: `👋 Hi, I'm EcomWallah — your e-commerce insights assistant.\n\nRight now: ${(m.orders||0).toLocaleString()} orders · ${fmt(m.rev)} revenue · delivery ${pct(m.delivRate)} · RTO ${pct(m.rtoRate)}.\n\n🔔 Most urgent: ${top ? `${top.icon} ${top.title}` : 'nothing critical'}.\n\nAsk me anything, or tap a suggestion below.`,
    }];
  });
  const [input, setInput] = useState('');
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const ask = (q) => {
    const text = (q ?? input).trim();
    if (!text) return;
    const reply = answer(text, data);
    setMsgs(ms => [...ms, { role: 'user', text }, { role: 'bot', text: reply }]);
    setInput('');
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', maxWidth:920, margin:'0 auto', width:'100%' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:12, padding:'4px 4px 14px' }}>
        <div style={{ width:44, height:44, borderRadius:13, background:'var(--accent-grad)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, boxShadow:'0 4px 14px rgba(79,70,229,.35)' }}>🤖</div>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:'var(--text)', display:'flex', alignItems:'center', gap:7 }}>
            EcomWallah <Sparkles size={16} color="var(--accent)"/>
          </div>
          <div style={{ fontSize:12, color:'var(--text3)' }}>Insights & business decisions from your live data</div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:12, padding:'4px 2px' }}>
        {msgs.map((msg, i) => (
          <div key={i} style={{ display:'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth:'82%', whiteSpace:'pre-wrap', lineHeight:1.55, fontSize:13.5,
              padding:'11px 15px', borderRadius:14,
              background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface)',
              color: msg.role === 'user' ? '#fff' : 'var(--text)',
              border: msg.role === 'user' ? 'none' : '1px solid var(--border)',
              borderBottomRightRadius: msg.role === 'user' ? 4 : 14,
              borderBottomLeftRadius: msg.role === 'user' ? 14 : 4,
              boxShadow:'var(--shadow)',
            }}>{msg.text}</div>
          </div>
        ))}
        <div ref={endRef}/>
      </div>

      {/* Suggestions */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', padding:'10px 2px' }}>
        {SUGGESTIONS.map(s => (
          <button key={s} onClick={() => ask(s)} style={{
            fontSize:12, padding:'6px 12px', borderRadius:20, cursor:'pointer',
            background:'var(--surface)', border:'1px solid var(--border)', color:'var(--text2)' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Input */}
      <div style={{ display:'flex', gap:10, padding:'4px 2px 2px' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') ask(); }}
          placeholder="Ask EcomWallah… e.g. 'which SKUs are declining?'"
          style={{ flex:1, padding:'12px 16px', fontSize:14, color:'var(--text)', background:'var(--surface)',
                   border:'1px solid var(--border)', borderRadius:12, outline:'none' }}/>
        <button onClick={() => ask()} style={{ display:'flex', alignItems:'center', gap:7, padding:'0 18px',
          background:'var(--accent-grad)', color:'#fff', borderRadius:12, fontSize:14, fontWeight:700,
          boxShadow:'0 4px 14px rgba(79,70,229,.35)' }}>
          <Send size={16}/> Ask
        </button>
      </div>
    </div>
  );
}
