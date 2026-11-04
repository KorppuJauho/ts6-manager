import api from './client';

export const serversApi = {
  list: () => api.get('/servers').then((r) => r.data),
  get: (id: number) => api.get(`/servers/${id}`).then((r) => r.data),
  create: (data: { name: string; host: string }) => api.post('/servers', data).then((r) => r.data),
  update: (id: number, data: { name?: string; host?: string }) => api.put(`/servers/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/servers/${id}`),
};
