import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Login removed — the dashboard is open to anyone with the link.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App userEmail="PW Orders" onLogout={() => window.location.reload()} />
  </React.StrictMode>
)
