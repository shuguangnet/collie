import { useEffect, useRef, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PairForm } from "@/components/paired-devices";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { AccessLoginError, accessPasswordConfigured, exchangeAccess } from "@/lib/access-login";
import { openBootFailed } from "@/lib/open-boot";
import { getDeviceToken, setDeviceToken, usePairing } from "@/lib/pairing";

/** No password is kept after a submission; only the normal revocable device token is persisted. */
export function AccessSignIn() {
  useLocale();
  const revalidator = useRevalidator();
  const { token, expired } = usePairing();
  const [search] = useSearchParams();
  const [pair, setPair] = useState(search.has("pair"));
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"incorrect" | "duplicate" | "limited" | "storage" | "unavailable" | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setStatusFailed(false);
    void accessPasswordConfigured(controller.signal).then(setConfigured).catch(() => {
      if (!controller.signal.aborted) setStatusFailed(true);
    });
    return () => controller.abort();
  }, [attempt]);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setProblem(null);
    const entered = password;
    setPassword("");
    try {
      const issued = await exchangeAccess("/api/auth/login", { label: label.trim(), password: entered });
      setDeviceToken(issued);
      if (getDeviceToken() !== issued) { setProblem("storage"); return; }
      revalidator.revalidate();
    } catch (error) {
      setProblem(error instanceof AccessLoginError
        ? error.status === 429 ? "limited"
          : error.code === "auth.password_incorrect" ? "incorrect"
            : error.code === "auth.duplicate_label" ? "duplicate" : "unavailable"
        : "unavailable");
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-8">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="space-y-3 p-4">
          <h1 className="text-lg font-medium">{t("access.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("access.description")}</p>
          <p className="text-sm text-muted-foreground">{t("access.localHint")}</p>
          <code className="block rounded-md bg-muted px-3 py-2 text-sm">collie open</code>
          {openBootFailed() && <p role="status" className="text-sm text-status-blocked">{t("access.openFailed")}</p>}
          {statusFailed ? (
            <div className="space-y-2">
              <p role="status">{t("access.unavailable")}</p>
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t("access.retry")}</Button>
            </div>
          ) : configured === null ? <Loader2 aria-label={t("access.loading")} className="size-5 animate-spin" />
            : !configured ? <p className="text-sm">{t("access.setup")} <code>collie password set</code></p>
              : !pair && (
                <form className="space-y-3" onSubmit={submit}>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t("access.device")}</span>
                    <input className="h-11 rounded-md border border-border bg-background px-3" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="username" maxLength={48} required />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>{t("access.password")}</span>
                    <input className="h-11 rounded-md border border-border bg-background px-3" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={512} required />
                  </label>
                  {problem && <p role="alert" className="min-h-5 text-sm text-status-blocked">{t(`access.${problem}`)}</p>}
                  <Button className="h-11 w-full" type="submit" disabled={busy || !label.trim() || !password}>
                    {busy && <Loader2 className="size-4 animate-spin" />}{t("access.signIn")}
                  </Button>
                </form>
              )}
          <Button variant="ghost" onClick={() => setPair((value) => !value)}>{t(pair ? "access.usePassword" : "access.useCode")}</Button>
        </div>
        {pair && <PairForm nameRef={nameRef} expired={expired} heldToken={token !== null} onPaired={() => revalidator.revalidate()} />}
      </Card>
    </main>
  );
}
