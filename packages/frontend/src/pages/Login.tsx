import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { authApi } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { applyUserLanguage } from '@/hooks/use-auth';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { Loader2, AlertCircle } from 'lucide-react';

type Step = 'password' | 'changePassword';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step>('password');
  const [changeToken, setChangeToken] = useState('');
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { setAuth } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  const finish = (data: any) => {
    setAuth(data.accessToken, data.refreshToken, data.user);
    applyUserLanguage(data.user);
    navigate('/');
  };

  // A forced password change comes before the session; otherwise sign in.
  const routeAuth = (res: any) => {
    if (res.mustChangePassword) { setChangeToken(res.changeToken); setCurPw(password); setNewPw(''); setConfirmPw(''); setStep('changePassword'); return; }
    finish(res);
  };

  if (isAuthenticated) return <Navigate to="/" replace />;

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      routeAuth(await authApi.login(username, password));
    } catch {
      setError(t('login.invalidCredentials'));
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPw !== confirmPw) { setError(t('login.passwordsDoNotMatch')); return; }
    setBusy(true);
    try {
      routeAuth(await authApi.loginChangePassword(changeToken, curPw, newPw));
    } catch (err: any) {
      setError(err.response?.data?.error || t('login.changeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background grid-bg">
      <div className="fixed top-3 right-3 z-10"><LanguageSwitcher /></div>
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="w-full max-w-sm mx-4 relative">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 border border-primary/20 mb-4">
            <span className="text-primary font-bold text-xl font-mono-data text-glow">TS</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">TeamSpeak 6 Manager</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('login.appSubtitle')}</p>
        </div>

        <Card className="border-border/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <h2 className="text-sm font-medium text-center text-muted-foreground">
              {step === 'password' ? t('login.signInToContinue') : t('login.changePasswordTitle')}
            </h2>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 rounded-md px-3 py-2 mb-4">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {step === 'password' && (
              <form onSubmit={handlePassword} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username" className="text-xs">{t('login.username')}</Label>
                  <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" autoFocus />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-xs">{t('login.password')}</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
                </div>
                <Button type="submit" className="w-full" disabled={busy || !username || !password}>
                  {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('login.signingIn')}</> : t('login.signIn')}
                </Button>
              </form>
            )}

            {step === 'changePassword' && (
              <form onSubmit={handleChangePassword} className="space-y-4">
                <p className="text-xs text-muted-foreground">{t('login.changePasswordPrompt')}</p>
                <div className="space-y-2">
                  <Label className="text-xs">{t('login.currentPassword')}</Label>
                  <Input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" autoFocus />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">{t('login.newPassword')}</Label>
                  <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">{t('login.confirmPassword')}</Label>
                  <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
                </div>
                <Button type="submit" className="w-full" disabled={busy || !curPw || !newPw || !confirmPw}>
                  {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('login.changingPassword')}</> : t('login.changeAndContinue')}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-[10px] text-muted-foreground/50 mt-6 font-mono-data">TS6 WEBUI v1.0.0</p>
      </div>
    </div>
  );
}
