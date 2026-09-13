import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tokensApi } from '@/api/bans.api';
import { useServerStore } from '@/stores/server.store';
import { DataTable } from '@/components/shared/DataTable';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { KeyRound, Trash2, Copy } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export default function Tokens() {
  const { t } = useTranslation();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data, isLoading } = useQuery({ queryKey: ['tokens', c, s], queryFn: () => tokensApi.list(c!, s!), enabled: !!c && !!s });
  const qc = useQueryClient();
  const deleteToken = useMutation({ mutationFn: (token: string) => tokensApi.delete(c!, s!, token), onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }) });

  const tokens = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const columns: ColumnDef<any>[] = useMemo(() => [
    { accessorKey: 'token', header: t('tokens.colToken'), cell: ({ getValue }) => (
      <div className="flex items-center gap-1">
        <span className="font-mono-data text-xs truncate max-w-[200px]">{getValue() as string}</span>
        <button onClick={() => { navigator.clipboard.writeText(getValue() as string); toast.success(t('tokens.copied')); }} className="p-1 hover:bg-muted rounded"><Copy className="h-3 w-3 text-muted-foreground" /></button>
      </div>
    )},
    { accessorKey: 'token_type', header: t('tokens.colType'), cell: ({ getValue }) => <span className="text-xs">{(getValue() as number) === 0 ? t('tokens.serverGroup') : t('tokens.channelGroup')}</span> },
    { accessorKey: 'token_id1', header: t('tokens.colGroupId'), cell: ({ getValue }) => <span className="font-mono-data text-xs">{getValue() as number}</span> },
    { accessorKey: 'token_description', header: t('tokens.colDescription'), cell: ({ getValue }) => <span className="text-xs">{(getValue() as string) || '-'}</span> },
    { id: 'actions', header: '', cell: ({ row }) => (
      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteToken.mutate(row.original.token, { onSuccess: () => toast.success(t('tokens.tokenDeleted')) })}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    )},
  ], [deleteToken, t]);

  if (!c || !s) return <EmptyState icon={KeyRound} title={t('tokens.noServerSelected')} />;
  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">{t('tokens.title')}</h1>
      <DataTable columns={columns} data={tokens} searchKey="token_description" searchPlaceholder={t('tokens.searchPlaceholder')} />
    </div>
  );
}
