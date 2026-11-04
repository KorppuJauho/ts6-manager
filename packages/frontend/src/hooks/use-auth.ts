import { authApi } from '../api/auth.api';
import { useAuthStore } from '../stores/auth.store';
import { useNavigate } from 'react-router-dom';

export function useLogout() {
  const { refreshToken, logout } = useAuthStore();
  const navigate = useNavigate();

  return () => {
    if (refreshToken) authApi.logout(refreshToken).catch(() => {});
    logout();
    navigate('/login');
  };
}
