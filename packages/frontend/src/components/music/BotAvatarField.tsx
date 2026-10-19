import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ImageOff, Upload } from 'lucide-react';
import type { BotAvatarMode, BotAvatarStatus } from '@ts6/common';
import { musicBotsApi } from '@/api/music.api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** The server's limit; checked here too so a too-large pick is refused at once. */
export const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif'];
/** The bundled app icon, the same picture the backend uploads for "default". */
const DEFAULT_AVATAR_URL = '/apple-touch-icon.png';

interface Props {
  /** Null while creating a bot. */
  botId: number | null;
  mode: BotAvatarMode;
  onModeChange: (mode: BotAvatarMode) => void;
  /** A picked image, not yet uploaded. */
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Whether the bot has a stored upload to show or switch back to. */
  uploaded: boolean;
  /** The setting the bot has saved, so the status is shown only for it. */
  savedMode: BotAvatarMode | null;
  status: BotAvatarStatus | null;
  running: boolean;
}

export function BotAvatarField({ botId, mode, onModeChange, file, onFileChange, uploaded, savedMode, status, running }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  const { data: storedBlob } = useQuery({
    queryKey: ['music-bot-avatar', botId],
    queryFn: () => musicBotsApi.avatarImage(botId!),
    enabled: botId !== null && uploaded && mode === 'upload' && !file,
    retry: false,
  });
  const storedUrl = useMemo(() => (storedBlob ? URL.createObjectURL(storedBlob) : null), [storedBlob]);
  useEffect(() => () => { if (storedUrl) URL.revokeObjectURL(storedUrl); }, [storedUrl]);

  const previewUrl = mode === 'default' ? DEFAULT_AVATAR_URL
    : mode === 'upload' ? (fileUrl ?? (uploaded ? storedUrl : null))
      : null;

  const pick = (picked: File | undefined) => {
    if (!picked) return;
    if (!AVATAR_TYPES.includes(picked.type)) {
      toast.error(t('musicBots.avatar.refused.notImage'));
      return;
    }
    if (picked.size > AVATAR_MAX_BYTES) {
      toast.error(t('musicBots.avatar.refused.tooBig'));
      return;
    }
    onFileChange(picked);
  };

  // What became of the saved setting in TeamSpeak. A changed, unsaved choice
  // has no status yet.
  const unchanged = savedMode === mode && !file;
  let statusText: string | null = null;
  let failed = false;
  if (botId !== null && unchanged) {
    if (!running) statusText = t('musicBots.avatar.state.offline');
    else if (status?.state === 'failed') {
      failed = true;
      statusText = t(`musicBots.avatar.failed.${status.reason ?? 'error'}`);
    } else if (status) statusText = t(`musicBots.avatar.state.${status.state}`);
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs">{t('musicBots.avatar.label')}</Label>
      <div className="flex items-start gap-3">
        <div className="h-16 w-16 shrink-0 rounded-md border bg-muted/40 flex items-center justify-center overflow-hidden">
          {previewUrl
            ? <img src={previewUrl} alt={t('musicBots.avatar.label')} className="max-h-full max-w-full object-contain" />
            : <ImageOff className="h-5 w-5 text-muted-foreground" aria-label={t('musicBots.avatar.noAvatar')} />}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <Select value={mode} onValueChange={(v) => onModeChange(v as BotAvatarMode)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="upload">{t('musicBots.avatar.modes.upload')}</SelectItem>
              <SelectItem value="default">{t('musicBots.avatar.modes.default')}</SelectItem>
              <SelectItem value="none">{t('musicBots.avatar.modes.none')}</SelectItem>
            </SelectContent>
          </Select>
          {mode === 'upload' && (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif"
                className="hidden"
                onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
              />
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => inputRef.current?.click()}>
                <Upload className="h-3 w-3 mr-1" />
                {file || uploaded ? t('musicBots.avatar.replace') : t('musicBots.avatar.choose')}
              </Button>
              {file && <p className="text-[11px] text-muted-foreground truncate">{file.name}</p>}
              <p className="text-[11px] text-muted-foreground">{t('musicBots.avatar.hint')}</p>
            </>
          )}
        </div>
      </div>
      {statusText && (
        <p className={`text-[11px] ${failed ? 'text-destructive' : 'text-muted-foreground'}`} role={failed ? 'alert' : undefined}>
          {statusText}
          {failed && status?.detail && <span className="block opacity-80">{status.detail}</span>}
        </p>
      )}
    </div>
  );
}
