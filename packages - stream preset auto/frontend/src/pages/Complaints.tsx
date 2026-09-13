import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { complaintsApi } from '@/api/bans.api';
import { useServerStore } from '@/stores/server.store';
import { DataTable } from '@/components/shared/DataTable';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { MessageSquareWarning } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import { timeAgo } from '@/lib/utils';

export default function Complaints() {
  const { t } = useTranslation();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data, isLoading } = useQuery({ queryKey: ['complaints', c, s], queryFn: () => complaintsApi.list(c!, s!), enabled: !!c && !!s });

  const complaints = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const columns: ColumnDef<any>[] = useMemo(() => [
    { accessorKey: 'fname', header: t('complaints.columnFrom') },
    { accessorKey: 'tname', header: t('complaints.columnAbout') },
    { accessorKey: 'message', header: t('complaints.columnMessage') },
    { accessorKey: 'timestamp', header: t('complaints.columnWhen'), cell: ({ getValue }) => <span className="text-xs text-muted-foreground">{timeAgo(getValue() as number)}</span> },
  ], [t]);

  if (!c || !s) return <EmptyState icon={MessageSquareWarning} title={t('complaints.noServerSelected')} />;
  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">{t('complaints.title')}</h1>
      <DataTable columns={columns} data={complaints} searchKey="message" searchPlaceholder={t('complaints.searchPlaceholder')} />
    </div>
  );
}
