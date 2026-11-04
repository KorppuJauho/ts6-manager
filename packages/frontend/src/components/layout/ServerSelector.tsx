import { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { Server } from 'lucide-react';

export function ServerSelector() {
  const { selectedConfigId, setServer, clearServer } = useServerStore();
  const { data: servers } = useServers();

  // Select the first server when none is selected, or when the remembered one
  // was deleted or is not visible to this user: the music pages take their
  // server from here. With no server at all, clear it so they say so.
  useEffect(() => {
    if (!Array.isArray(servers)) return;
    if (servers.length === 0) {
      if (selectedConfigId !== null) clearServer();
      return;
    }
    if (!servers.some((s: any) => s.id === selectedConfigId)) setServer(servers[0].id);
  }, [servers, selectedConfigId, setServer, clearServer]);

  return (
    <div className="flex items-center gap-2">
      <Server className="h-4 w-4 text-muted-foreground" />
      <Select
        value={selectedConfigId?.toString() || ''}
        onValueChange={(v) => setServer(parseInt(v))}
      >
        <SelectTrigger className="w-[180px] h-8 text-xs">
          <SelectValue placeholder="Select server..." />
        </SelectTrigger>
        <SelectContent>
          {servers?.map((s: any) => (
            <SelectItem key={s.id} value={s.id.toString()}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
