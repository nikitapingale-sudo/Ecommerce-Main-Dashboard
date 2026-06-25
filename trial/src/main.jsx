import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LoginPage from './components/LoginPage.jsx'
import './index.css'

function Root() {
  const [email, setEmail] = useState(() => (localStorage.getItem('pw_token') ? localStorage.getItem('pw_email') : null));
  const logout = () => { localStorage.removeItem('pw_token'); localStorage.removeItem('pw_email'); setEmail(null); };
  if (!email) return <LoginPage onAuth={setEmail}/>;
  return <App userEmail={email} onLogout={logout}/>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>)
