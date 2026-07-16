# Token Expiration Handling Guide

This guide explains how the frontend should handle token expiration from the backend.

## Backend Token System

The backend uses two types of tokens:
1. **User Tokens** - For regular users (stored in `user_sessions` table)
2. **Admin Tokens** - For platform admins (stored in `admin_sessions` table)

Both tokens use an idle timeout mechanism (default 30 minutes, configurable via `TOKEN_IDLE_TIMEOUT_MINUTES` environment variable).

## Backend Responses for Expired Tokens

When a token is expired or invalid, the backend returns a **403 Forbidden** status with the following response:

```json
{
  "success": false,
  "error": "Invalid or expired token"
}
```

Or for admin tokens:
```json
{
  "success": false,
  "error": "Invalid or expired admin token"
}
```

## Frontend Implementation Steps

### 1. Setup Axios Interceptor (or equivalent for your HTTP client)

Create a response interceptor to check for token expiration responses.

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: process.env.API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle token expiration
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response) {
      // Check for 403 status and token expiration error
      if (
        error.response.status === 403 &&
        (error.response.data?.error === 'Invalid or expired token' ||
          error.response.data?.error === 'Invalid or expired admin token')
      ) {
        // Logout user
        handleSessionExpired();
      }
    }
    return Promise.reject(error);
  }
);

function handleSessionExpired() {
  // Clear local storage
  localStorage.removeItem('authToken');
  localStorage.removeItem('user'); // Or any other user data

  // Show session expired modal
  showSessionExpiredModal();
}

function showSessionExpiredModal() {
  // Implement your modal UI here
  const modal = document.createElement('div');
  modal.innerHTML = `
    <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999;">
      <div style="background: white; padding: 2rem; border-radius: 8px; text-align: center;">
        <h2>Session Expired</h2>
        <p>Your session has expired due to inactivity. Please log in again to continue.</p>
        <button onclick="redirectToLogin()" style="background: #007bff; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; cursor: pointer; font-size: 1rem;">
          Log In Again
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function redirectToLogin() {
  window.location.href = '/login'; // Replace with your login page URL
}

export default api;
```

### 2. Implement with React Context (Example)

```jsx
import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('authToken'));
  const [showSessionExpired, setShowSessionExpired] = useState(false);

  useEffect(() => {
    if (token) {
      // Verify token on app load (optional)
      verifyToken();
    }
  }, [token]);

  const verifyToken = async () => {
    try {
      // Call an endpoint to verify token (e.g., /me)
      const response = await api.get('/me');
      setUser(response.data.data);
    } catch (error) {
      handleSessionExpired();
    }
  };

  const handleSessionExpired = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('authToken');
    setShowSessionExpired(true);
  };

  const login = async (email, password) => {
    const response = await api.post('/auth/login', { email, password });
    const newToken = response.data.data.token;
    localStorage.setItem('authToken', newToken);
    setToken(newToken);
    setUser(response.data.data.user);
    setShowSessionExpired(false);
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('authToken');
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
      {showSessionExpired && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-8 rounded-lg text-center">
            <h2 className="text-2xl font-bold mb-4">Session Expired</h2>
            <p className="text-gray-600 mb-6">
              Your session has expired due to inactivity. Please log in again to continue.
            </p>
            <button
              onClick={() => {
                setShowSessionExpired(false);
                logout();
              }}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Log In Again
            </button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

### 3. Key Points to Remember

1. **All authenticated requests** must include the token in the `Authorization` header as `Bearer <token>`
2. **On any 403 response** with the error message indicating token expiration, immediately log out the user
3. **Clear all user data** from local storage when logging out due to expiration
4. **Show a clear modal** explaining that the session expired and prompting the user to log in again
5. **Redirect to login page** when the user clicks "Log In Again"

## Token Timeout Configuration

The backend's idle timeout duration can be configured using the `TOKEN_IDLE_TIMEOUT_MINUTES` environment variable (defaults to 30 minutes).

## Admin Panel Handling

The same logic applies to the admin panel! The admin token expiration response is:
```json
{
  "success": false,
  "error": "Invalid or expired admin token"
}
```
