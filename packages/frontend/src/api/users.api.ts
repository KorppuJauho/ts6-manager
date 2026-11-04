import api from './client';

export const usersApi = {
  list: () => api.get('/users').then((r) => r.data),
  create: (data: any) => api.post('/users', data).then((r) => r.data),
  update: (id: number, data: any) => api.put(`/users/${id}`, data),
  delete: (id: number) => api.delete(`/users/${id}`),
  passwordPolicy: (): Promise<{ minLength: number; requireComplexity: boolean }> =>
    api.get('/users/password-policy').then((r) => r.data),
  updatePasswordPolicy: (data: { minLength: number; requireComplexity: boolean }) =>
    api.put('/users/password-policy', data).then((r) => r.data),
};
