import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { LANGUAGES, setLanguage } from '@/i18n';
import { authApi } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { Flag } from '@/components/shared/Flag';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const { user, setAuth, accessToken, refreshToken } = useAuthStore();
  const current = LANGUAGES.find((l) => i18n.resolvedLanguage === l.code) ?? LANGUAGES[0];

  const choose = (code: string) => {
    setLanguage(code);
    // Persist to the account (best-effort) and reflect it in the store
    if (accessToken) {
      authApi.setLanguage(code).catch(() => { /* ignore */ });
      if (user) setAuth(accessToken, refreshToken!, { ...user, language: code });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 px-2" title="Language">
          <Flag code={current.country} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {LANGUAGES.map((l) => (
          <DropdownMenuItem key={l.code} onClick={() => choose(l.code)} className="gap-2">
            <Flag code={l.country} />
            <span className="text-xs">{l.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
