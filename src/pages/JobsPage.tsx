import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Spinner } from "@/components/ds";
import { CalendarClock, Pause, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import type { HermesClient, Job } from "@/lib/api";
import type { DashboardClient } from "@/lib/dashboard";
import { useApp } from "@/store";
import { formatDate } from "@/lib/utils";
import { EmptyState, IconButton, PageTitle, Panel, SectionLabel, TextField } from "@/components/ui";
import { ProfileChips } from "@/components/ProfileChips";

type JobAction = "pause" | "resume" | "run";

/** The same page over the API server's /api/jobs or the dashboard's /api/cron/jobs. */
interface JobsBackend {
  list(): Promise<Job[]>;
  create(job: { name: string; schedule: string; prompt: string }, profile: string): Promise<unknown>;
  act(job: Job, action: JobAction): Promise<unknown>;
  remove(job: Job): Promise<unknown>;
}

function apiJobs(client: HermesClient): JobsBackend {
  return {
    list: () => client.jobs(),
    create: (job) => client.createJob(job),
    act: (job, action) => client.jobAction(job.id, action),
    remove: (job) => client.deleteJob(job.id),
  };
}

function dashboardJobs(dashboard: DashboardClient, profile: string): JobsBackend {
  return {
    list: () => dashboard.cronJobs(profile),
    create: (job, target) => dashboard.createCronJob(target, job),
    // The dashboard calls "run now" trigger; a paused job is resumed for that run.
    act: (job, action) => dashboard.cronAction(job.id, job.profile, action === "run" ? "trigger" : action),
    remove: (job) => dashboard.deleteCronJob(job.id, job.profile),
  };
}

function scheduleText(job: Job): string {
  if (job.schedule_display) return job.schedule_display;
  if (typeof job.schedule === "string") return job.schedule;
  if (job.schedule && typeof job.schedule === "object") {
    const s = job.schedule as Record<string, unknown>;
    return String(s.display ?? s.expr ?? s.cron ?? JSON.stringify(s));
  }
  return "—";
}

function isPaused(job: Job) {
  return Boolean(job.paused_at) || job.state === "paused" || job.enabled === false;
}

export function JobsPage({ leading }: { leading?: ReactNode }) {
  const { client, dashboard, profiles, profileFilter, setProfileFilter, notify } = useApp();
  const backend = useMemo(
    () => (dashboard ? dashboardJobs(dashboard, profileFilter) : client ? apiJobs(client) : null),
    [client, dashboard, profileFilter],
  );
  const profileNames = profiles.map((p) => p.name);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    if (!backend) return;
    try {
      setJobs(await backend.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [backend]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(job: Job, action: JobAction | "delete") {
    if (!backend) return;
    try {
      if (action === "delete") {
        if (!window.confirm(`¿Borrar el job "${job.name ?? job.id}"?`)) return;
        await backend.remove(job);
      } else {
        await backend.act(job, action);
      }
      notify(
        { pause: "Job pausado", resume: "Job reanudado", run: "Job lanzado", delete: "Job borrado" }[action],
      );
      void load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <PageShell leading={leading}>
      <PageTitle
        actions={
          <>
            <IconButton label="Recargar" onClick={() => void load()}>
              <RefreshCw />
            </IconButton>
            <IconButton label="Nuevo job" active={showForm} onClick={() => setShowForm((v) => !v)}>
              <Plus />
            </IconButton>
          </>
        }
      >
        Jobs
      </PageTitle>

      {dashboard && profileNames.length > 1 && (
        <ProfileChips profiles={profileNames} value={profileFilter} onChange={setProfileFilter} />
      )}

      {showForm && backend && (
        <NewJobForm
          backend={backend}
          // Dashboard: the job lands in one profile; API key mode has only one.
          profiles={dashboard ? profileNames : []}
          defaultProfile={profileFilter !== "all" ? profileFilter : (profiles.find((p) => p.is_default)?.name ?? "default")}
          onCreated={() => {
            setShowForm(false);
            notify("Job creado");
            void load();
          }}
        />
      )}

      {error && <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {!jobs && !error && (
        <div className="flex justify-center py-12 text-text-secondary">
          <Spinner />
        </div>
      )}
      {jobs && jobs.length === 0 && (
        <EmptyState icon={<CalendarClock />} title="Sin jobs">
          Los jobs programados (cron) de Hermes aparecen acá. Creá uno con el botón +.
        </EmptyState>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {jobs?.map((job) => {
          const paused = isPaused(job);
          return (
            <Panel key={`${job.profile ?? ""}/${job.id}`} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-bold text-midground">{job.name || job.id}</h3>
                  <p className="font-mono text-xs text-text-tertiary">
                    {scheduleText(job)}
                    {dashboard && profileFilter === "all" && job.profile ? ` · ${job.profile}` : ""}
                  </p>
                </div>
                <Badge tone={paused ? "secondary" : job.last_status === "error" ? "destructive" : "success"}>
                  {paused ? "Pausado" : job.last_status || "Activo"}
                </Badge>
              </div>
              {job.prompt && <p className="line-clamp-3 text-sm text-text-secondary">{job.prompt}</p>}
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <SectionLabel>Próximo</SectionLabel>
                  <dd className="text-text-secondary">{formatDate(job.next_run_at)}</dd>
                </div>
                <div>
                  <SectionLabel>Último</SectionLabel>
                  <dd className="text-text-secondary">{formatDate(job.last_run_at)}</dd>
                </div>
              </dl>
              {job.last_error && <p className="text-xs text-destructive">{job.last_error}</p>}
              <div className="flex items-center gap-1 border-t border-current/10 pt-2">
                <IconButton label="Ejecutar ahora" onClick={() => void act(job, "run")}>
                  <Zap />
                </IconButton>
                {paused ? (
                  <IconButton label="Reanudar" onClick={() => void act(job, "resume")}>
                    <Play />
                  </IconButton>
                ) : (
                  <IconButton label="Pausar" onClick={() => void act(job, "pause")}>
                    <Pause />
                  </IconButton>
                )}
                <span className="flex-1" />
                <IconButton label="Borrar" className="hover:text-destructive" onClick={() => void act(job, "delete")}>
                  <Trash2 />
                </IconButton>
              </div>
            </Panel>
          );
        })}
      </div>
    </PageShell>
  );
}

function NewJobForm({
  backend,
  profiles,
  defaultProfile,
  onCreated,
}: {
  backend: JobsBackend;
  profiles: string[];
  defaultProfile: string;
  onCreated: () => void;
}) {
  const [profile, setProfile] = useState(defaultProfile);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await backend.create({ name: name.trim(), schedule: schedule.trim(), prompt }, profile);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {profiles.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Perfil</SectionLabel>
            <ProfileChips includeAll={false} profiles={profiles} value={profile} onChange={setProfile} />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} required />
          <TextField
            label="Programación"
            placeholder="0 9 * * *  ·  every 2h  ·  30m"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            autoCapitalize="off"
            required
            hint="Cron, intervalo o fecha, igual que `hermes cron`"
          />
        </div>
        <label className="flex flex-col gap-1.5">
          <SectionLabel>Prompt</SectionLabel>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            className="w-full resize-y border border-midground/15 bg-background/40 p-3 text-base text-midground rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:border-midground/40"
          />
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="h-12 self-end px-6">
          {busy ? <Spinner /> : "Crear job"}
        </Button>
      </form>
    </Panel>
  );
}

export function PageShell({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {leading && (
        <div className="flex h-14 shrink-0 items-center border-b border-current/20 px-2">{leading}</div>
      )}
      <div className="scroll-area min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-[calc(var(--safe-bottom)+2rem)] sm:px-8">
          {children}
        </div>
      </div>
    </div>
  );
}
