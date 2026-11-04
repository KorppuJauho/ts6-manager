import api from './client';

export const authApi = {
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }).then((r) => r.data),

  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refreshToken }).then((r) => r.data),

  logout: (refreshToken: string) =>
    api.post('/auth/logout', { refreshToken }),

  me: () => api.get('/auth/me').then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),

  setLanguage: (language: string) =>
    api.put('/auth/language', { language }).then((r) => r.data),

  // Forced password change at login
  loginChangePassword: (changeToken: string, currentPassword: string, newPassword: string) =>
    api.post('/auth/login/change-password', { changeToken, currentPassword, newPassword }).then((r) => r.data),
};
