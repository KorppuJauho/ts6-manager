import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { journalApi, type ConnectionLogEntry } from '@/api/journal.api';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Flag } from '@/components/shared/Flag';
import { ChevronLeft, ChevronRight, Globe, MessagesSquare, ArrowUp, ArrowDown, X, Ban, ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

type SortField = 'createdAt' | 'login' | 'ip' | 'country' | 'success';

let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['fr'], { type: 'region' }); } catch { /* older runtime */ }
function countryName(country: string | null): string {
  if (!country) return '';
  try { return regionNames?.of(country) ?? country; } catch { return country; }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
}

function BanDialog({ entry, source, onClose }: { entry: ConnectionLogEntry | null; source: 'web' | 'teamspeak'; onClose: () => void }) {
  const { t } = useTranslation();
  const [web, setWeb] = useState(false);
  const [ts, setTs] = useState(false);
  const [duration, setDuration] = useState(0);
  const [reason, setReason] = useState('');

  // Pre-check the target matching the current tab each time the dialog opens
  // (or when the source tab changes while it is open).
  const seedKey = entry ? `${source}:${entry.id}` : null;
  const [prevSeedKey, setPrevSeedKey] = useState<string | null>(seedKey);
  if (seedKey !== prevSeedKey) {
    setPrevSeedKey(seedKey);
    if (entry) { setWeb(source === 'web'); setTs(source === 'teamspeak'); setDuration(0); setReason(''); }
  }

  const ban = useMutation({
    mutationFn: () => journalApi.ban({
      ip: entry!.ip,
      targets: [...(web ? ['web' as const] : []), ...(ts ? ['teamspeak' as const] : [])],
      durationMinutes: duration,
      reason: reason || undefined,
    }),
    onSuccess: () => { toast.success(t('journal.banApplied')); onClose(); },
    onError: (err: any) => toast.error(err.response?.data?.error || t('journal.banFailed')),
  });

  return (
    <Dialog open={entry !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('journal.banTitle')}</DialogTitle></DialogHeader>
        {entry && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('journal.banIntro')} <span className="font-mono-data">{entry.ip}</span>
              {entry.login ? <> · <span className="font-medium">{entry.login}</span></> : null}
            </p>
            <div className="flex items-center gap-2">
              <Switch checked={web} onCheckedChange={setWeb} />
              <Label className="text-xs font-normal">{t('journal.banWeb')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={ts} onCheckedChange={setTs} />
              <Label className="text-xs font-normal">{t('journal.banTeamSpeak')}</Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('journal.banDuration')}</Label>
              <Input type="number" min={0} value={duration} onChange={(e) => setDuration(parseInt(e.target.value) || 0)} className="h-8 text-xs w-32" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('journal.banReason')}</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('journal.cancel')}</Button>
          <Button variant="destructive" size="sm" disabled={(!web && !ts) || ban.isPending} onClick={() => ban.mutate()}>
            {ban.isPending ? t('journal.banning') : t('journal.banConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebBansDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: bans = [] } = useQuery({ queryKey: ['web-bans'], queryFn: journalApi.webBans, enabled: open });
  const revoke = useMutation({
    mutationFn: (id: number) => journalApi.deleteWebBan(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['web-bans'] }); toast.success(t('journal.banRevoked')); },
    onError: () => toast.error(t('journal.banFailed')),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('journal.webBansTitle')}</DialogTitle></DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto">
          {bans.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">{t('journal.noWebBans')}</p>
          ) : bans.map((b) => (
            <div key={b.id} className="flex items-center gap-2 py-2 border-b border-border last:border-0">
              <span className="font-mono-data text-xs flex-1">{b.ip}</span>
              <span className="text-[10px] text-muted-foreground">
                {b.expiresAt ? new Date(b.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : t('journal.permanent')}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => revoke.mutate(b.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LocationCell({ e }: { e: ConnectionLogEntry }) {
  const { t } = useTranslation();
  if (e.country) return <span className="inline-flex items-center gap-1.5" title={countryName(e.country)}><Flag code={e.country} /> {e.country}</span>;
  if (e.ip && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1)/.test(e.ip)) {
    return <Badge variant="outline" className="text-[10px]">{t('journal.lan')}</Badge>;
  }
  return <span className="text-muted-foreground">—</span>;
}

// Debounce a value to avoid a request per keystroke on text filters.
function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const PAGE_SIZE = 50;

export default function Journal() {
  const { t } = useTranslation();
  const [source, setSource] = useState<'web' | 'teamspeak'>('web');
  const [page, setPage] = useState(1);
  const [hideBots, setHideBots] = useState(true);
  const [sort, setSort] = useState<SortField>('createdAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  const [loginF, setLoginF] = useState('');
  const [ipF, setIpF] = useState('');
  const [countryF, setCountryF] = useState('');
  const [resultF, setResultF] = useState<'all' | 'success' | 'failed'>('all');

  const login = useDebounced(loginF);
  const ip = useDebounced(ipF);
  const country = useDebounced(countryF);

  // Reset to page 1 whenever a filter, sort or tab changes.
  const filterKey = JSON.stringify([source, hideBots, sort, dir, login, ip, country, resultF]);
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setPage(1);
  }

  const { data, isLoading } = useQuery({
    queryKey: ['journal', source, page, hideBots, sort, dir, login, ip, country, resultF],
    queryFn: () => journalApi.list({
      source, page, limit: PAGE_SIZE, hideBots, sort, dir,
      login: login || undefined,
      ip: ip || undefined,
      country: country || undefined,
      result: source === 'web' && resultF !== 'all' ? resultF : undefined,
    }),
    refetchInterval: 15000,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (field: SortField) => {
    if (sort === field) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(field); setDir(field === 'createdAt' ? 'desc' : 'asc'); }
  };

  // Render helper (not a nested component) so it isn't recreated as a new
  // component type on every render.
  const sortHead = (field: SortField, label: string) => (
    <th className="h-10 px-3 text-left font-medium text-muted-foreground">
      <button className="inline-flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort(field)}>
        {label}
        {sort === field && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  const hasFilters = loginF || ipF || countryF || resultF !== 'all';
  const resetFilters = () => { setLoginF(''); setIpF(''); setCountryF(''); setResultF('all'); };

  const [banEntry, setBanEntry] = useState<ConnectionLogEntry | null>(null);
  const [showWebBans, setShowWebBans] = useState(false);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('journal.title')}</h1>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={source} onValueChange={(v) => { setSource(v as any); resetFilters(); }}>
          <TabsList>
            <TabsTrigger value="web"><Globe className="h-3.5 w-3.5 mr-1" /> {t('journal.tabWeb')}</TabsTrigger>
            <TabsTrigger value="teamspeak"><MessagesSquare className="h-3.5 w-3.5 mr-1" /> {t('journal.tabTeamSpeak')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowWebBans(true)}>
            <ShieldOff className="h-3.5 w-3.5 mr-1" /> {t('journal.webBans')}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetFilters}>
              <X className="h-3.5 w-3.5 mr-1" /> {t('journal.resetFilters')}
            </Button>
          )}
          {source === 'teamspeak' && (
            <div className="flex items-center gap-2">
              <Switch checked={hideBots} onCheckedChange={setHideBots} />
              <Label className="text-xs font-normal">{t('journal.hideBots')}</Label>
            </div>
          )}
        </div>
      </div>

      {isLoading ? <PageLoader /> : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {sortHead('login', t('journal.colLogin'))}
                {sortHead('createdAt', t('journal.colDateTime'))}
                {sortHead('ip', t('journal.colIp'))}
                {sortHead('country', t('journal.colLocation'))}
                {source === 'web' && sortHead('success', t('journal.colResult'))}
                <th className="h-10 px-3 text-right font-medium text-muted-foreground">{t('journal.colActions')}</th>
              </tr>
              <tr className="border-b border-border bg-background">
                <th className="px-2 py-1.5"><Input value={loginF} onChange={(e) => setLoginF(e.target.value)} placeholder={t('journal.filterPlaceholder')} className="h-7 text-xs" /></th>
                <th></th>
                <th className="px-2 py-1.5"><Input value={ipF} onChange={(e) => setIpF(e.target.value)} placeholder={t('journal.filterPlaceholder')} className="h-7 text-xs" /></th>
                <th className="px-2 py-1.5"><Input value={countryF} onChange={(e) => setCountryF(e.target.value)} placeholder={t('journal.filterCountryPlaceholder')} className="h-7 text-xs" /></th>
                {source === 'web' && (
                  <th className="px-2 py-1.5">
                    <Select value={resultF} onValueChange={(v) => setResultF(v as any)}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t('journal.resultAll')}</SelectItem>
                        <SelectItem value="success">{t('journal.resultSuccess')}</SelectItem>
                        <SelectItem value="failed">{t('journal.resultFailed')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </th>
                )}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">{t('journal.noEntries')}</td></tr>
              ) : entries.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5">
                    {e.login}
                    {e.isBot && <Badge variant="outline" className="ml-2 text-[10px]">{t('journal.bot')}</Badge>}
                  </td>
                  <td className="px-3 py-2.5 font-mono-data text-xs">{formatDate(e.createdAt)}</td>
                  <td className="px-3 py-2.5 font-mono-data text-xs">{e.ip || '—'}</td>
                  <td className="px-3 py-2.5"><LocationCell e={e} /></td>
                  {source === 'web' && (
                    <td className="px-3 py-2.5">
                      {e.success
                        ? <span className="text-xs text-emerald-400">{t('journal.success')}</span>
                        : <span className="text-xs text-destructive">{t('journal.failed')}</span>}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right">
                    {e.ip && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title={t('journal.ban')} onClick={() => setBanEntry(e)}>
                        <Ban className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t('journal.entryCount', { count: total })}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <BanDialog entry={banEntry} source={source} onClose={() => setBanEntry(null)} />
      <WebBansDialog open={showWebBans} onClose={() => setShowWebBans(false)} />
    </div>
  );
}
