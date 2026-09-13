import { useState } from 'react';
import { useServerGroups, useServerGroupMembers, useCreateServerGroup, useDeleteServerGroup, useAddServerGroupMember, useRemoveServerGroupMember } from '@/hooks/use-groups';
import { useClients } from '@/hooks/use-clients';
import { useServerStore } from '@/stores/server.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Shield, Plus, Trash2, Users, ChevronRight, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export default function ServerGroups() {
  const { t } = useTranslation();
  const { selectedConfigId, selectedSid } = useServerStore();
  const { data, isLoading } = useServerGroups();
  const createGroup = useCreateServerGroup();
  const deleteGroup = useDeleteServerGroup();
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const { data: members } = useServerGroupMembers(selectedGroup);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sgid: number; name: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const addMember = useAddServerGroupMember();
  const removeMember = useRemoveServerGroupMember();
  const { data: clientsData } = useClients();

  if (!selectedConfigId || !selectedSid) return <EmptyState icon={Shield} title={t('serverGroups.noServerSelected')} />;
  if (isLoading) return <PageLoader />;

  const groups = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('serverGroups.title')}</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> {t('serverGroups.createGroup')}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Group List */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('serverGroups.groupsCount', { n: groups.length })}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[500px]">
              <div className="p-2 space-y-0.5">
                {groups.map((g: any) => (
                  <button
                    key={g.sgid}
                    onClick={() => setSelectedGroup(g.sgid)}
                    className={cn(
                      'flex items-center justify-between w-full rounded-md px-3 py-2 text-sm transition-colors text-left',
                      selectedGroup === g.sgid ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5" />
                      <span className="truncate">{g.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] font-mono-data">{g.sgid}</Badge>
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Members */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                {t('serverGroups.members')}
                {selectedGroup && <Badge variant="default" className="font-mono-data text-[10px]">SGID: {selectedGroup}</Badge>}
              </CardTitle>
              {selectedGroup && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setMemberSearch(''); setShowAddMember(true); }}>
                    <UserPlus className="h-3 w-3 mr-1" /> {t('serverGroups.addMember')}
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                    const g = groups.find((g: any) => g.sgid === selectedGroup);
                    if (g) setDeleteTarget({ sgid: g.sgid, name: g.name });
                  }}>
                    <Trash2 className="h-3 w-3 mr-1" /> {t('serverGroups.deleteGroup')}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!selectedGroup ? (
              <p className="text-sm text-muted-foreground text-center py-12">{t('serverGroups.selectGroupHint')}</p>
            ) : (
              <ScrollArea className="h-[440px]">
                <div className="space-y-1">
                  {Array.isArray(members) && members.length > 0 ? (
                    members.map((m: any, i: number) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/30 transition-colors group">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-mono-data text-primary">
                            {m.client_nickname?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span className="text-sm">{m.client_nickname || `DBID: ${m.cldbid}`}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground font-mono-data">DBID: {m.cldbid}</span>
                          <button
                            className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            title={t('serverGroups.removeMember')}
                            onClick={() => removeMember.mutate({ sgid: selectedGroup!, cldbid: Number(m.cldbid) }, {
                              onSuccess: () => toast.success(t('serverGroups.memberRemoved')),
                              onError: () => toast.error(t('serverGroups.memberActionFailed')),
                            })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">{t('serverGroups.noMembers')}</p>
                  )}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('serverGroups.createServerGroup')}</DialogTitle></DialogHeader>
          <div><Label className="text-xs">{t('serverGroups.groupName')}</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('serverGroups.groupNamePlaceholder')} autoFocus /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('serverGroups.cancel')}</Button>
            <Button onClick={() => { createGroup.mutate(newName, { onSuccess: () => { toast.success(t('serverGroups.groupCreated')); setShowCreate(false); setNewName(''); } }); }}>{t('serverGroups.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)} title={t('serverGroups.deleteServerGroup')} description={t('serverGroups.deleteConfirm', { name: deleteTarget?.name })} confirmLabel={t('serverGroups.delete')} destructive onConfirm={() => { if (deleteTarget) deleteGroup.mutate(deleteTarget.sgid, { onSuccess: () => { toast.success(t('serverGroups.groupDeleted')); setDeleteTarget(null); setSelectedGroup(null); } }); }} />

      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('serverGroups.addMemberTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder={t('serverGroups.searchClient')} autoFocus />
            <ScrollArea className="h-[300px]">
              <div className="space-y-1">
                {(Array.isArray(clientsData) ? clientsData : [])
                  .filter((c: any) => String(c.client_type) === '0')
                  .filter((c: any) => (c.client_nickname || '').toLowerCase().includes(memberSearch.toLowerCase()))
                  .map((c: any) => (
                    <button
                      key={c.clid}
                      className="flex items-center justify-between w-full rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left"
                      onClick={() => addMember.mutate({ sgid: selectedGroup!, cldbid: Number(c.client_database_id) }, {
                        onSuccess: () => { toast.success(t('serverGroups.memberAdded')); setShowAddMember(false); },
                        onError: () => toast.error(t('serverGroups.memberActionFailed')),
                      })}
                    >
                      <span className="truncate">{c.client_nickname}</span>
                      <span className="text-xs text-muted-foreground font-mono-data">DBID: {c.client_database_id}</span>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMember(false)}>{t('serverGroups.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
