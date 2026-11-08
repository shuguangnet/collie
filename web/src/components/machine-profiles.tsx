import { useState } from "react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Select } from "@/components/ui/select";
import { useLocale } from "@/hooks/use-locale";
import { deleteMachineProfile, saveMachineProfile, isApiErrorStatus } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { MachineProfileInput, MachineProfilesDocument } from "@/lib/types";

const EMPTY: MachineProfileInput = { name: "", sshHost: "", port: 8787, mux: "", leadAddress: "", peerAddress: "", remotePath: "", instance: "" };
const INPUT = "min-h-11 min-w-0 rounded-md border border-border bg-background px-3 text-base";

/** Service-owned drafts. Saving is deliberately not an install or a network probe. */
export function MachineProfiles({ document, failed, readOnly }: { document: MachineProfilesDocument | null; failed: boolean; readOnly: boolean }) {
  useLocale();
  const revalidator = useRevalidator();
  const muxes = document?.muxes ?? [];
  const [form, setForm] = useState<MachineProfileInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"invalid" | "conflict" | "unavailable" | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (!form || busy || readOnly) return;
    setBusy(true); setProblem(null);
    try { await saveMachineProfile(form); setForm(null); await revalidator.revalidate(); }
    catch (error) { setProblem(isApiErrorStatus(error, 409) ? "conflict" : isApiErrorStatus(error, 400) ? "invalid" : "unavailable"); }
    finally { setBusy(false); }
  }
  async function forget(id: string) {
    if (busy || readOnly) return;
    setBusy(true); setProblem(null);
    try { await deleteMachineProfile(id); setRemove(null); await revalidator.revalidate(); }
    catch { setProblem("unavailable"); }
    finally { setBusy(false); }
  }
  function field(key: "name" | "sshHost" | "leadAddress" | "peerAddress" | "remotePath" | "instance", required = false) {
    return <label className="flex min-w-0 flex-col gap-1 text-sm"><span>{t(`profiles.${key}`)}</span><input className={INPUT} value={form?.[key] ?? ""} onChange={(event) => setForm((held) => held && ({ ...held, [key]: event.target.value }))} required={required} maxLength={key === "remotePath" ? 1024 : key === "leadAddress" ? 512 : key === "name" ? 48 : key === "instance" ? 16 : 255} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>;
  }
  return <Card className="gap-3 p-4">
    <h2 className="font-medium">{t("profiles.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("profiles.description")}</p>
    <p className="text-sm text-muted-foreground">{t("profiles.runtime")}</p>
    {(failed || problem) && <p role="alert" className="min-h-5 text-sm text-status-blocked">{t(`profiles.${problem ?? "unavailable"}`)}</p>}
    {document?.profiles.length === 0 && <p className="text-sm text-muted-foreground">{t("profiles.empty")}</p>}
    <ul className="flex flex-col gap-3">
      {document?.profiles.map((profile) => {
        const command = `collie crew add --saved ${profile.id}`;
        return <li key={profile.id} className="min-w-0 space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{profile.name}</h3><span className="text-xs text-muted-foreground">{t("profiles.saved")}</span></div>
          <p className="break-all font-mono text-sm">{profile.sshHost} · {profile.mux} · {profile.port}</p>
          <p className="text-sm text-muted-foreground">{t("profiles.commandHint")}</p>
          <CopyableBlock text={command}><pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{command}</pre></CopyableBlock>
          {!readOnly && (remove === profile.id ? <div className="space-y-2"><p className="text-sm">{t("profiles.removeHint")}</p><div className="flex gap-2"><Button className="min-h-11" variant="outline" disabled={busy} onClick={() => void forget(profile.id)}>{t("profiles.confirmRemove")}</Button><Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => setRemove(null)}>{t("profiles.cancel")}</Button></div></div> : <Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => setRemove(profile.id)}>{t("profiles.remove")}</Button>)}
        </li>;
      })}
    </ul>
    {!readOnly && !failed && document && (form ? <form className="space-y-3 border-t border-border pt-3" onSubmit={save}>
      {field("name", true)}{field("sshHost", true)}
      <p className="text-xs text-muted-foreground">{t("profiles.sshHint")}</p>
      <div className="grid grid-cols-2 gap-3"><label className="flex flex-col gap-1 text-sm"><span>{t("profiles.port")}</span><input className={INPUT} type="number" min={1} max={65535} required value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label><label className="flex flex-col gap-1 text-sm"><span>{t("profiles.mux")}</span><Select value={form.mux} onChange={(event) => { const mux = muxes.find((value) => value === event.target.value); if (mux) setForm({ ...form, mux }); }}>{muxes.map((mux) => <option key={mux} value={mux}>{mux}</option>)}</Select></label></div>
      {field("leadAddress")}{field("peerAddress")}{field("remotePath")}{field("instance")}
      <p className="text-xs text-muted-foreground">{t("profiles.addressHint")}</p>
      <div className="flex gap-2"><Button className="min-h-11" type="submit" disabled={busy}>{t(busy ? "profiles.saving" : "profiles.save")}</Button><Button className="min-h-11" type="button" variant="ghost" disabled={busy} onClick={() => { setForm(null); setProblem(null); }}>{t("profiles.cancel")}</Button></div>
    </form> : <Button className="min-h-11" variant="outline" disabled={muxes.length === 0} onClick={() => setForm({ ...EMPTY, mux: muxes[0]! })}>{t("profiles.add")}</Button>)}
  </Card>;
}
