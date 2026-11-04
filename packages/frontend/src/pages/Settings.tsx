import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api/users.api';
import { authApi } from '@/api/auth.api';
import { serversApi } from '@/api/servers.api';
import { settingsApi, proxyApi, limitsApi } from '@/api/settings.api';
import { spotifyApi } from '@/api/spotify.api';
import { musicCommandSettingsApi } from '@/api/music-command-settings.api';
import { streamSettingsApi, type StreamSettings } from '@/api/stream-settings.api';
import { useAuthStore } from '@/stores/auth.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Users, Server, Plus, Trash2, Pencil, Check, Lock, KeyRound, Youtube, Upload, FileText, Music, Bot, Video } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export default function Settings() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>

      <Tabs defaultValue="account">
        <TabsList>
          {isAdmin && <TabsTrigger value="connections"><Server className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.connections')}</TabsTrigger>}
          <TabsTrigger value="account"><Lock className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.account')}</TabsTrigger>
          {isAdmin && <TabsTrigger value="users"><Users className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.users')}</TabsTrigger>}
          {isAdmin && <TabsTrigger value="youtube"><Youtube className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.youtube')}</TabsTrigger>}
          {isAdmin && <TabsTrigger value="spotify"><Music className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.spotify')}</TabsTrigger>}
          {isAdmin && <TabsTrigger value="musicCommands"><Bot className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.musicCommands')}</TabsTrigger>}
          {isAdmin && <TabsTrigger value="streaming"><Video className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.streaming')}</TabsTrigger>}
        </TabsList>

        {isAdmin && (
          <TabsContent value="connections" className="mt-4">
            <ConnectionsTab />
          </TabsContent>
        )}

        <TabsContent value="account" className="mt-4">
          <AccountTab />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="users" className="mt-4">
            <UsersTab />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="youtube" className="mt-4">
            <YouTubeTab />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="spotify" className="mt-4">
            <SpotifyTab />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="streaming" className="mt-4">
            <StreamingTab />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="musicCommands" className="mt-4">
            <MusicCommandsTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function AccountTab() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const changePassword = useMutation({
    mutationFn: () => authApi.changePassword(currentPassword, newPassword),
  });

  const handleSubmit = () => {
    if (newPassword.length < 6) {
      toast.error(t('settings.account.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('settings.account.passwordsDoNotMatch'));
      return;
    }
    changePassword.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('settings.account.passwordChanged'));
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error || 'Failed to change password';
        toast.error(msg);
      },
    });
  };

  return (
    <div className="max-w-md space-y-4">

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('settings.account.changePassword')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">{t('settings.account.currentPassword')}</Label>
            <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">{t('settings.account.newPassword')}</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">{t('settings.account.confirmPassword')}</Label>
            <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!currentPassword || !newPassword || !confirmPassword || changePassword.isPending}
            className="w-full mt-1"
          >
            {changePassword.isPending ? t('settings.account.changing') : t('settings.account.changePassword')}
          </Button>
        </CardContent>
      </Card>

    </div>
  );
}

function ConnectionsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: servers, isLoading } = useQuery({ queryKey: ['servers'], queryFn: serversApi.list });
  const createServer = useMutation({ mutationFn: (data: { name: string; host: string }) => serversApi.create(data), onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }) });
  const updateServer = useMutation({ mutationFn: ({ id, data }: { id: number; data: { name: string; host: string } }) => serversApi.update(id, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }) });
  const deleteServer = useMutation({
    mutationFn: (id: number) => serversApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      qc.invalidateQueries({ queryKey: ['music-bots'] });
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', host: '' });

  const serverList = useMemo(() => (Array.isArray(servers) ? servers : []), [servers]);

  if (isLoading) return <PageLoader />;

  const resetForm = () => setForm({ name: '', host: '' });
  const closeDialog = () => { setShowAdd(false); setEditId(null); resetForm(); };

  const handleSave = () => {
    const payload = { name: form.name.trim(), host: form.host.trim() };
    if (editId) {
      updateServer.mutate({ id: editId, data: payload }, {
        onSuccess: () => { toast.success(t('settings.connections.toastUpdated')); closeDialog(); },
        onError: () => toast.error(t('settings.connections.toastUpdateFailed')),
      });
    } else {
      createServer.mutate(payload, {
        onSuccess: () => { toast.success(t('settings.connections.toastAdded')); closeDialog(); },
        onError: () => toast.error(t('settings.connections.toastCreateFailed')),
      });
    }
  };

  const openEdit = (server: any) => {
    setForm({ name: server.name || '', host: server.host || '' });
    setEditId(server.id);
    setShowAdd(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.connections.subtitle')}</p>
        <Button size="sm" onClick={() => { resetForm(); setEditId(null); setShowAdd(true); }}><Plus className="h-4 w-4 mr-1" /> {t('settings.connections.add')}</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {serverList.map((server: any) => (
          <Card key={server.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{server.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">{t('settings.connections.host')}</span>
                <span className="font-mono-data">{server.host}</span>
              </div>
              <div className="flex items-center gap-1 pt-2">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEdit(server)}>
                  <Pencil className="h-3 w-3 mr-1" /> {t('settings.connections.edit')}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(server.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={showAdd} onOpenChange={(v) => { if (!v) closeDialog(); else setShowAdd(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editId ? t('settings.connections.dialogEditTitle') : t('settings.connections.dialogAddTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">{t('settings.connections.name')}</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('settings.connections.namePlaceholder')} /></div>
            <div>
              <Label className="text-xs">{t('settings.connections.host')}</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="ts.example.com" />
              <p className="text-[10px] text-muted-foreground mt-1">{t('settings.connections.hostHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>{t('settings.connections.cancel')}</Button>
            <Button onClick={handleSave} disabled={!form.name.trim() || !form.host.trim()}>{editId ? t('settings.connections.update') : t('settings.connections.addShort')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title={t('settings.connections.deleteTitle')}
        description={t('settings.connections.deleteDescription')}
        onConfirm={() => { if (deleteId) deleteServer.mutate(deleteId, { onSuccess: () => { toast.success(t('settings.connections.toastDeleted')); setDeleteId(null); } }); }}
        destructive
      />
    </div>
  );
}

function UsersTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const createUser = useMutation({ mutationFn: (data: any) => usersApi.create(data), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const updateUser = useMutation({ mutationFn: ({ id, data }: { id: number; data: any }) => usersApi.update(id, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const deleteUser = useMutation({ mutationFn: (id: number) => usersApi.delete(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const { data: servers } = useQuery({ queryKey: ['servers'], queryFn: serversApi.list });
  const serverList = useMemo(() => (Array.isArray(servers) ? servers : []), [servers]);

  const [showAdd, setShowAdd] = useState(false);
  const [accessUserId, setAccessUserId] = useState<number | null>(null);
  const [accessIds, setAccessIds] = useState<number[]>([]);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwMustChange, setResetPwMustChange] = useState(false);
  const emptyForm = { username: '', password: '', displayName: '', role: 'viewer', mustChangePassword: false, serverIds: [] as number[] };
  const [form, setForm] = useState(emptyForm);

  const userList = useMemo(() => (Array.isArray(users) ? users : []), [users]);

  if (isLoading) return <PageLoader />;

  const handleCreate = () => {
    createUser.mutate({ ...form, serverIds: form.role === 'viewer' ? form.serverIds : [] }, {
      onSuccess: () => { toast.success(t('settings.users.toastCreated')); setShowAdd(false); setForm(emptyForm); },
      onError: () => toast.error(t('settings.users.toastCreateFailed')),
    });
  };

  const handleRoleChange = (userId: number, role: string) => {
    updateUser.mutate({ id: userId, data: { role } }, {
      onSuccess: () => toast.success(t('settings.users.toastRoleUpdated')),
      onError: () => toast.error(t('settings.users.toastRoleFailed')),
    });
  };

  const handleToggleEnabled = (userId: number, enabled: boolean) => {
    updateUser.mutate({ id: userId, data: { enabled } }, {
      onSuccess: () => toast.success(enabled ? t('settings.users.toastEnabled') : t('settings.users.toastDisabled')),
      onError: () => toast.error(t('settings.users.toastStatusFailed')),
    });
  };

  const openAccess = (u: any) => {
    setAccessUserId(u.id);
    setAccessIds(Array.isArray(u.serverIds) ? u.serverIds : []);
  };

  const handleSaveAccess = () => {
    if (!accessUserId) return;
    updateUser.mutate({ id: accessUserId, data: { serverIds: accessIds } }, {
      onSuccess: () => { toast.success(t('settings.users.toastAccessSaved')); setAccessUserId(null); },
      onError: () => toast.error(t('settings.users.toastAccessFailed')),
    });
  };

  const handleResetPassword = () => {
    if (!resetPwUserId || resetPwValue.length < 6) {
      toast.error(t('settings.users.passwordMinError'));
      return;
    }
    updateUser.mutate({ id: resetPwUserId, data: { password: resetPwValue, mustChangePassword: resetPwMustChange } }, {
      onSuccess: () => { toast.success(t('settings.users.toastPasswordReset')); setResetPwUserId(null); setResetPwValue(''); setResetPwMustChange(false); },
      onError: () => toast.error(t('settings.users.toastPasswordResetFailed')),
    });
  };

  return (
    <div className="space-y-4">
      <PasswordPolicyCard />
      <ReverseProxyCard />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('settings.users.subtitle')}</p>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-1" /> {t('settings.users.add')}</Button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">{t('settings.users.colUsername')}</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">{t('settings.users.colDisplayName')}</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">{t('settings.users.colRole')}</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">{t('settings.users.colStatus')}</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">{t('settings.users.colServers')}</th>
              <th className="h-10 px-3 text-right font-medium text-muted-foreground">{t('settings.users.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {userList.map((u: any) => {
              const isProtected = u.username === 'admin';
              return (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 font-mono-data text-xs">{u.username}</td>
                  <td className="px-3 py-2.5">{u.displayName}</td>
                  <td className="px-3 py-2.5">
                    {isProtected ? (
                      <Badge variant="default" className="text-[10px] capitalize">{u.role}</Badge>
                    ) : (
                      <Select value={u.role} onValueChange={(v) => handleRoleChange(u.id, v)}>
                        <SelectTrigger className="h-7 w-[110px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">{t('settings.users.roleAdmin')}</SelectItem>
                          <SelectItem value="viewer">{t('settings.users.roleViewer')}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {isProtected ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                        <Check className="h-3 w-3" /> {t('settings.users.active')}
                      </span>
                    ) : (
                      <Switch
                        checked={u.enabled}
                        onCheckedChange={(v) => handleToggleEnabled(u.id, v)}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {u.role === 'admin' ? (
                      <span className="text-xs text-muted-foreground">{t('settings.users.allServers')}</span>
                    ) : (
                      <Button variant="outline" size="sm" className="h-7 text-xs" title={t('settings.users.serverAccessTitle')} onClick={() => openAccess(u)}>
                        {t('settings.users.serverCount', { count: (u.serverIds ?? []).length })}
                      </Button>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="inline-flex items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('settings.users.resetPasswordTitle')} onClick={() => { setResetPwUserId(u.id); setResetPwValue(''); }}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(u.id)} disabled={isProtected}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add User Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings.users.addDialogTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">{t('settings.users.username')}</Label><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="johndoe" /></div>
            <div><Label className="text-xs">{t('settings.users.displayName')}</Label><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="John Doe" /></div>
            <div><Label className="text-xs">{t('settings.users.password')}</Label><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="********" /></div>
            <div>
              <Label className="text-xs">{t('settings.users.role')}</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t('settings.users.roleAdmin')}</SelectItem>
                  <SelectItem value="viewer">{t('settings.users.roleViewer')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.role === 'viewer' && (
              <div>
                <Label className="text-xs">{t('settings.users.serverAccess')}</Label>
                <ServerChecklist servers={serverList} value={form.serverIds} onChange={(serverIds) => setForm({ ...form, serverIds })} />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch checked={form.mustChangePassword} onCheckedChange={(v) => setForm({ ...form, mustChangePassword: v })} />
              <Label className="text-xs font-normal">{t('settings.users.mustChangePassword')}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>{t('settings.users.cancel')}</Button>
            <Button onClick={handleCreate} disabled={!form.username || !form.password}>{t('settings.users.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Server Access Dialog */}
      <Dialog open={accessUserId !== null} onOpenChange={(v) => { if (!v) setAccessUserId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('settings.users.serverAccessDialogTitle', { user: userList.find((u: any) => u.id === accessUserId)?.username ?? '' })}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('settings.users.serverAccessHint')}</p>
          <ServerChecklist servers={serverList} value={accessIds} onChange={setAccessIds} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAccessUserId(null)}>{t('settings.users.cancel')}</Button>
            <Button onClick={handleSaveAccess} disabled={updateUser.isPending}>{t('settings.users.saveAccess')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetPwUserId !== null} onOpenChange={(v) => { if (!v) { setResetPwUserId(null); setResetPwValue(''); setResetPwMustChange(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('settings.users.resetPasswordDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('settings.users.setNewPasswordFor')} <span className="font-medium text-foreground">{userList.find((u: any) => u.id === resetPwUserId)?.username}</span>
            </p>
            <div>
              <Label className="text-xs">{t('settings.users.newPassword')}</Label>
              <Input type="password" value={resetPwValue} onChange={(e) => setResetPwValue(e.target.value)} placeholder={t('settings.users.minCharsPlaceholder')} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={resetPwMustChange} onCheckedChange={setResetPwMustChange} />
              <Label className="text-xs font-normal">{t('settings.users.mustChangePassword')}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetPwUserId(null); setResetPwValue(''); }}>{t('settings.users.cancel')}</Button>
            <Button onClick={handleResetPassword} disabled={resetPwValue.length < 6 || updateUser.isPending}>
              {updateUser.isPending ? t('settings.users.resetting') : t('settings.users.resetPassword')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title={t('settings.users.deleteTitle')}
        description={t('settings.users.deleteDescription')}
        onConfirm={() => { if (deleteId) deleteUser.mutate(deleteId, { onSuccess: () => { toast.success(t('settings.users.toastDeleted')); setDeleteId(null); } }); }}
        destructive
      />
    </div>
  );
}

/** Checkboxes for the servers a viewer may see. */
function ServerChecklist({ servers, value, onChange }: { servers: any[]; value: number[]; onChange: (ids: number[]) => void }) {
  const { t } = useTranslation();
  if (servers.length === 0) return <p className="text-xs text-muted-foreground mt-1">{t('settings.users.noServers')}</p>;
  return (
    <div className="space-y-1.5 mt-1">
      {servers.map((s: any) => (
        <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox
            checked={value.includes(s.id)}
            onCheckedChange={(checked) => onChange(checked ? [...value, s.id] : value.filter((id) => id !== s.id))}
          />
          <span>{s.name}</span>
          <span className="text-muted-foreground font-mono-data">{s.host}</span>
        </label>
      ))}
    </div>
  );
}

function YouTubeTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [pasteMode, setPasteMode] = useState(false);
  const [cookieText, setCookieText] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['yt-cookie-status'],
    queryFn: settingsApi.getYtCookieStatus,
  });

  const uploadFile = useMutation({
    mutationFn: (file: File) => settingsApi.uploadYtCookieFile(file),
    onSuccess: () => {
      toast.success(t('settings.youtube.toastFileUploaded'));
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error(t('settings.youtube.toastUploadFailed')),
  });

  const uploadText = useMutation({
    mutationFn: (text: string) => settingsApi.uploadYtCookieText(text),
    onSuccess: () => {
      toast.success(t('settings.youtube.toastCookiesSaved'));
      setCookieText('');
      setPasteMode(false);
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error(t('settings.youtube.toastSaveFailed')),
  });

  const deleteCookies = useMutation({
    mutationFn: () => settingsApi.deleteYtCookies(),
    onSuccess: () => {
      toast.success(t('settings.youtube.toastCookiesRemoved'));
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error(t('settings.youtube.toastRemoveFailed')),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile.mutate(file);
    e.target.value = '';
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('settings.youtube.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t('settings.youtube.description')}
            {' '}<span className="font-medium">Get cookies.txt LOCALLY</span> {t('settings.youtube.descriptionBrowsers')}
          </p>

          {/* Status */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.active ? 'bg-green-500' : 'bg-zinc-500'}`} />
            <span className="text-sm">
              {isLoading ? t('settings.youtube.loading') : status?.active
                ? t('settings.youtube.cookiesActive', { size: formatSize(status.size) })
                : t('settings.youtube.noCookies')}
            </span>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <input
              type="file"
              accept=".txt,.cookies"
              className="hidden"
              id="cookie-file-input"
              onChange={handleFileSelect}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById('cookie-file-input')?.click()}
              disabled={uploadFile.isPending}
            >
              <Upload className="h-3.5 w-3.5 mr-1" />
              {uploadFile.isPending ? t('settings.youtube.uploading') : t('settings.youtube.uploadFile')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPasteMode(!pasteMode)}
            >
              <FileText className="h-3.5 w-3.5 mr-1" />
              {t('settings.youtube.pasteCookies')}
            </Button>
            {status?.active && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => deleteCookies.mutate()}
                disabled={deleteCookies.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('settings.youtube.remove')}
              </Button>
            )}
          </div>

          {/* Paste mode */}
          {pasteMode && (
            <div className="space-y-2">
              <textarea
                className="w-full h-32 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;COOKIE_NAME&#9;COOKIE_VALUE"
                value={cookieText}
                onChange={(e) => setCookieText(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => uploadText.mutate(cookieText)}
                  disabled={!cookieText.trim() || uploadText.isPending}
                >
                  {uploadText.isPending ? t('settings.youtube.saving') : t('settings.youtube.save')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { setPasteMode(false); setCookieText(''); }}>
                  {t('settings.youtube.cancel')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <PlaylistImportLimitCard />
    </div>
  );
}

// ─── Playlist Import Limit Card ──────────────────────────────

function PlaylistImportLimitCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings-limits'], queryFn: limitsApi.get });
  const [max, setMax] = useState(50);

  const [seededData, setSeededData] = useState<typeof data>(undefined);
  if (data && data !== seededData) {
    setSeededData(data);
    setMax(data.maxPlaylistImport);
  }

  const save = useMutation({
    mutationFn: () => limitsApi.update(max),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-limits'] });
      toast.success(t('settings.youtube.playlistLimit.toastSaved'));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.youtube.playlistLimit.toastSaveFailed')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t('settings.youtube.playlistLimit.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('settings.youtube.playlistLimit.description')}</p>
        <div className="flex items-center gap-3">
          <Label className="text-xs w-40">{t('settings.youtube.playlistLimit.maxTracks')}</Label>
          <Input className="h-8 text-xs w-24" type="number" min={0} max={1000} value={max}
            onChange={(e) => setMax(parseInt(e.target.value) || 0)} />
        </div>
        <p className="text-[10px] text-muted-foreground">{t('settings.youtube.playlistLimit.hint')}</p>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.youtube.playlistLimit.saving') : t('settings.youtube.playlistLimit.save')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Spotify Tab ─────────────────────────────────────────────

function SpotifyTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['spotify-settings'], queryFn: spotifyApi.settings });
  const [form, setForm] = useState<{ enabled: boolean; clientId: string; clientSecret: string; maxAlbumTracks: number }>({
    enabled: false, clientId: '', clientSecret: '', maxAlbumTracks: 50,
  });

  const [seededSettings, setSeededSettings] = useState<typeof settings>(undefined);
  if (settings && settings !== seededSettings) {
    setSeededSettings(settings);
    setForm({
      enabled: settings.enabled,
      clientId: settings.clientId || '',
      clientSecret: '',
      maxAlbumTracks: settings.maxAlbumTracks,
    });
  }

  const save = useMutation({
    mutationFn: () => spotifyApi.updateSettings({
      enabled: form.enabled,
      clientId: form.clientId,
      clientSecret: form.clientSecret || undefined,
      maxAlbumTracks: form.maxAlbumTracks,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spotify-settings'] });
      toast.success(t('settings.spotify.toastSaved'));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.spotify.toastSaveFailed')),
  });

  if (isLoading || !settings) return <PageLoader />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('settings.spotify.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        <p className="text-[11px] text-muted-foreground">
          {t('settings.spotify.descriptionPre')} <span className="font-mono">!play</span> /{' '}
          <span className="font-mono">/play</span> {t('settings.spotify.descriptionOr')} <span className="font-mono">!spotify</span>{t('settings.spotify.descriptionMid')}{' '}
          <a className="underline" href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            {t('settings.spotify.dashboardLink')}
          </a>{' '}
          {t('settings.spotify.descriptionPost')}
        </p>

        <div className="flex items-center gap-2">
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
          <Label className="text-xs">{t('settings.spotify.enable')}</Label>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.spotify.clientId')}</Label>
          <Input className="h-8 text-xs" value={form.clientId}
            onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.spotify.clientSecret')}</Label>
          <Input className="h-8 text-xs" type="password"
            placeholder={settings.hasClientSecret ? t('settings.spotify.clientSecretPlaceholderSet') : t('settings.spotify.clientSecretPlaceholder')}
            value={form.clientSecret} onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.spotify.maxAlbumTracks')}</Label>
          <Input className="h-8 text-xs w-32" type="number" min={1} value={form.maxAlbumTracks}
            onChange={(e) => setForm((f) => ({ ...f, maxAlbumTracks: parseInt(e.target.value) || 50 }))} />
        </div>

        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.spotify.saving') : t('settings.spotify.save')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Music Bot Commands Tab ──────────────────────────────────

function MusicCommandsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['music-command-settings'],
    queryFn: musicCommandSettingsApi.get,
  });

  const [form, setForm] = useState<{ notifyNowPlaying: boolean }>({ notifyNowPlaying: false });

  const [seededSettings, setSeededSettings] = useState<typeof settings>(undefined);
  if (settings && settings !== seededSettings) {
    setSeededSettings(settings);
    setForm({
      notifyNowPlaying: settings.notifyNowPlaying,
    });
  }

  const save = useMutation({
    mutationFn: () => musicCommandSettingsApi.update({
      notifyNowPlaying: form.notifyNowPlaying,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['music-command-settings'] });
      toast.success(t('settings.musicCommands.toastSaved'));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.musicCommands.toastSaveFailed')),
  });

  if (isLoading || !settings) return <PageLoader />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('settings.musicCommands.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        <p className="text-[11px] text-muted-foreground">{t('settings.musicCommands.description')}</p>

        <div className="flex items-center gap-2">
          <Switch checked={form.notifyNowPlaying} onCheckedChange={(v) => setForm((f) => ({ ...f, notifyNowPlaying: v }))} />
          <Label className="text-xs">{t('settings.musicCommands.notifyNowPlaying')}</Label>
        </div>

        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.musicCommands.saving') : t('settings.musicCommands.save')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Password Policy Card ────────────────────────────────────

function PasswordPolicyCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: policy } = useQuery({ queryKey: ['password-policy'], queryFn: usersApi.passwordPolicy });
  const [minLength, setMinLength] = useState(12);
  const [requireComplexity, setRequireComplexity] = useState(true);

  const [seededPolicy, setSeededPolicy] = useState<typeof policy>(undefined);
  if (policy && policy !== seededPolicy) {
    setSeededPolicy(policy);
    setMinLength(policy.minLength);
    setRequireComplexity(policy.requireComplexity);
  }

  const save = useMutation({
    mutationFn: () => usersApi.updatePasswordPolicy({ minLength, requireComplexity }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['password-policy'] }); toast.success(t('settings.users.passwordPolicy.toastSaved')); },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.users.passwordPolicy.toastSaveFailed')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('settings.users.passwordPolicy.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 max-w-xl">
        <div className="flex items-center gap-3">
          <Label className="text-xs w-40">{t('settings.users.passwordPolicy.minLength')}</Label>
          <Input className="h-8 text-xs w-24" type="number" min={1} max={128} value={minLength}
            onChange={(e) => setMinLength(parseInt(e.target.value) || 1)} />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={requireComplexity} onCheckedChange={setRequireComplexity} />
          <Label className="text-xs font-normal">
            {t('settings.users.passwordPolicy.requireComplexity')}
            <span className="text-muted-foreground"> {t('settings.users.passwordPolicy.requireComplexityHint')}</span>
          </Label>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {t('settings.users.passwordPolicy.appliedHint')}
        </p>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.users.passwordPolicy.saving') : t('settings.users.passwordPolicy.savePolicy')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Reverse Proxy Card ──────────────────────────────────────

function ReverseProxyCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['proxy-settings'], queryFn: proxyApi.get });
  const [hops, setHops] = useState(1);

  const [seededData, setSeededData] = useState<typeof data>(undefined);
  if (data && data !== seededData) {
    setSeededData(data);
    setHops(data.trustHops);
  }

  const save = useMutation({
    mutationFn: () => proxyApi.update(hops),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['proxy-settings'] }); toast.success(t('settings.users.reverseProxy.toastSaved')); },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.users.reverseProxy.toastSaveFailed')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('settings.users.reverseProxy.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 max-w-xl">
        <p className="text-[11px] text-muted-foreground">
          {t('settings.users.reverseProxy.description')}
        </p>
        <div className="flex items-center gap-3">
          <Label className="text-xs w-40">{t('settings.users.reverseProxy.trustedHops')}</Label>
          <Input className="h-8 text-xs w-24" type="number" min={0} max={16} value={hops}
            onChange={(e) => setHops(parseInt(e.target.value) || 0)} />
        </div>
        <p className="text-[10px] text-muted-foreground">
          {t('settings.users.reverseProxy.detectedIpPre')} <span className="font-mono-data">{data?.detectedIp || '—'}</span>.
          {' '}{t('settings.users.reverseProxy.detectedIpPost')}
        </p>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.users.reverseProxy.saving') : t('settings.users.reverseProxy.save')}
        </Button>
      </CardContent>
    </Card>
  );
}

function StreamingTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['stream-settings'], queryFn: streamSettingsApi.get });
  const { data: options } = useQuery({ queryKey: ['stream-settings-options'], queryFn: streamSettingsApi.options });

  const [form, setForm] = useState<StreamSettings | null>(null);
  const [seeded, setSeeded] = useState<StreamSettings | undefined>(undefined);
  if (settings && settings !== seeded) {
    setSeeded(settings);
    setForm(settings);
  }

  const save = useMutation({
    mutationFn: () => streamSettingsApi.update({ ...form!, videoCodec: selectedCodec }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stream-settings'] });
      toast.success(t('settings.streaming.toastSaved'));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.streaming.toastSaveFailed')),
  });

  if (isLoading || !form) return <PageLoader />;

  const set = <K extends keyof StreamSettings>(key: K, value: StreamSettings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const codecs = options?.codecs ?? [];
  const selectedCodec = form.videoCodec ?? 'vp8';
  const codec = codecs.find((c) => c.codec === selectedCodec);

  // Hardware for the chosen codec may simply not exist on this GPU — the
  // sidecar probes by encoding, so this reflects what will actually happen
  // rather than what FFmpeg was built with.
  const hardwareUnavailable = form.hwAccelEnabled && codec !== undefined && !codec.hardwareAvailable;
  // docker-compose.nvidia.yml hands the sidecar an NVIDIA GPU, which has no
  // render node to choose: the device field has nothing to set.
  const nvidia = options?.hwBackend === 'nvenc';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('settings.streaming.encodingTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 max-w-xl">
          <p className="text-[11px] text-muted-foreground">{t('settings.streaming.encodingDescription')}</p>

          <div className="flex items-center gap-2">
            <Switch checked={form.hwAccelEnabled} onCheckedChange={(v) => set('hwAccelEnabled', v)} />
            <Label className="text-xs">{t('settings.streaming.hwAccelEnabled')}</Label>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.hwAccelDevice')}</Label>
            <Input
              className="h-8 text-xs font-mono"
              placeholder="/dev/dri/renderD128"
              value={form.hwAccelDevice}
              disabled={!form.hwAccelEnabled || nvidia}
              onChange={(e) => set('hwAccelDevice', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              {t(nvidia ? 'settings.streaming.hwAccelDeviceNvidia' : 'settings.streaming.hwAccelDeviceHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.codec')}</Label>
            <Select value={selectedCodec} onValueChange={(v) => set('videoCodec', v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {codecs.map((c) => (
                  <SelectItem
                    key={c.codec}
                    value={c.codec}
                    disabled={form.hwAccelEnabled ? !c.hardwareAvailable && !c.softwareAvailable : !c.softwareAvailable}
                  >
                    {c.label}
                    {form.hwAccelEnabled && !c.hardwareAvailable && ` — ${t('settings.streaming.noHardwareForCodec')}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options && !options.sidecarReachable && (
              <p className="text-[10px] text-amber-600 dark:text-amber-500">
                {t('settings.streaming.sidecarUnreachable')}
              </p>
            )}
            {hardwareUnavailable && (
              <p className="text-[10px] text-amber-600 dark:text-amber-500">
                {t('settings.streaming.hardwareUnavailableForCodec')}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">{t('settings.streaming.codecHint')}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('settings.streaming.playbackTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 max-w-xl">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.defaultPreset')}</Label>
            <Select value={form.defaultPreset} onValueChange={(v) => set('defaultPreset', v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('settings.streaming.presetAuto')}</SelectItem>
                {(options?.presets ?? []).map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label} — {p.width}x{p.height}, {p.bitrate}, {p.framerate} FPS
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">{t('settings.streaming.defaultPresetHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.autoMaxPreset')}</Label>
            {/* Only Auto reads the limit, so with a fixed default it has nothing
                to limit. `!stream <url> auto` still uses it; switch the default to
                Auto to change it. */}
            <Select
              value={form.autoMaxPreset}
              onValueChange={(v) => set('autoMaxPreset', v)}
              disabled={form.defaultPreset !== 'auto'}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(options?.presets ?? []).map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label} — {p.width}x{p.height}, {p.bitrate}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">{t('settings.streaming.autoMaxPresetHint')}</p>
          </div>

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('settings.streaming.iptvTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 max-w-xl">
          <p className="text-[11px] text-muted-foreground">{t('settings.streaming.iptvDescription')}</p>

          <div className="flex items-center gap-2">
            <Switch checked={form.iptvEnabled} onCheckedChange={(v) => set('iptvEnabled', v)} />
            <Label className="text-xs">{t('settings.streaming.iptvEnabled')}</Label>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.iptvPlaylistUrl')}</Label>
            <Input
              className="h-8 text-xs font-mono"
              placeholder="http://192.168.1.10:9191/output/m3u"
              value={form.iptvPlaylistUrl}
              disabled={!form.iptvEnabled}
              onChange={(e) => set('iptvPlaylistUrl', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">{t('settings.streaming.iptvPlaylistUrlHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.iptvChannelFilter')}</Label>
            <Input
              className="h-8 text-xs"
              placeholder="yle tv1, yle tv2, mtv 3"
              value={form.iptvChannelFilter}
              disabled={!form.iptvEnabled}
              onChange={(e) => set('iptvChannelFilter', e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">{t('settings.streaming.iptvChannelFilterHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.streaming.iptvSort')}</Label>
            <Select value={form.iptvSort} onValueChange={(v) => set('iptvSort', v)} disabled={!form.iptvEnabled}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="name">{t('settings.streaming.iptvSortName')}</SelectItem>
                <SelectItem value="playlist">{t('settings.streaming.iptvSortPlaylist')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Button size="sm" className="h-8 text-xs" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? t('common.saving') : t('common.save')}
      </Button>
    </div>
  );
}
