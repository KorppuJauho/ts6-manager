import { useVirtualServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { formatUptime } from '@/lib/utils';
import { Server, Play, Square, Users, Clock } from 'lucide-react';
import { serversApi } from '@/api/servers.api';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export default function VirtualServers() {
  const { t } = useTranslation();
  const { selectedConfigId } = useServerStore();
  const { data, isLoading } = useVirtualServers();
  const qc = useQueryClient();

  if (!selectedConfigId) return <EmptyState icon={Server} title={t('virtualServers.noServerSelected')} />;
  if (isLoading) return <PageLoader />;

  const servers = Array.isArray(data) ? data : [];

  const handleStart = async (sid: number) => {
    try {
      await serversApi.startVirtual(selectedConfigId, sid);
      toast.success(t('virtualServers.serverStarted'));
      qc.invalidateQueries({ queryKey: ['virtual-servers'] });
    } catch { toast.error(t('virtualServers.startFailed')); }
  };

  const handleStop = async (sid: number) => {
    try {
      await serversApi.stopVirtual(selectedConfigId, sid);
      toast.success(t('virtualServers.serverStopped'));
      qc.invalidateQueries({ queryKey: ['virtual-servers'] });
    } catch { toast.error(t('virtualServers.stopFailed')); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('virtualServers.title')}</h1>
        <Badge variant="secondary" className="font-mono-data">{t('virtualServers.serverCount', { count: servers.length })}</Badge>
      </div>

      <div className="grid gap-3">
        {servers.map((vs: any) => (
          <Card key={vs.virtualserver_id} className="hover:border-primary/30 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                    <Server className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{vs.virtualserver_name}</span>
                      <Badge variant={vs.virtualserver_status === 'online' ? 'success' : 'secondary'} className="text-[10px]">
                        {vs.virtualserver_status?.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      <span className="font-mono-data">{t('virtualServers.sidLabel', { sid: vs.virtualserver_id })}</span>
                      <span className="font-mono-data">{t('virtualServers.portLabel', { port: vs.virtualserver_port })}</span>
                      {vs.virtualserver_status === 'online' && (
                        <>
                          <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {vs.virtualserver_clientsonline - (vs.virtualserver_queryclientsonline || 0)}/{vs.virtualserver_maxclients}</span>
                          <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatUptime(vs.virtualserver_uptime || 0)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {vs.virtualserver_status === 'online' ? (
                    <Button variant="outline" size="sm" onClick={() => handleStop(vs.virtualserver_id)}>
                      <Square className="h-3 w-3 mr-1" /> {t('virtualServers.stop')}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => handleStart(vs.virtualserver_id)}>
                      <Play className="h-3 w-3 mr-1" /> {t('virtualServers.start')}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
