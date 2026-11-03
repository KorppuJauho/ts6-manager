import { useQuery } from '@tanstack/react-query';
import { serversApi } from '../api/servers.api';

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: serversApi.list,
  });
}
