import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FirebaseApp, initializeApp } from "firebase/app";
import { Auth, User, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Activity, Bell, Check, ChevronDown, CircleAlert, Clock3, DoorOpen, Footprints, Gauge, LogOut, PlugZap, RefreshCw, Settings, ShieldCheck, Sparkles, X } from "lucide-react";
import "./styles.css";

type Kind = "motion" | "current" | "power";
interface Entity { entityId: string; kind: Kind; label?: string }
interface Config { enabled: boolean; householdId: string; timezone: string; entities: Entity[]; windowMinutes: number; baselineDays: number; minimumBaselineWindows: number; alertThreshold: number; consecutiveWindows: number; webhookEnabled: boolean; lastCollectedAt: string | null; soterProjectId: string; soterDeviceId: string }
interface Features { motionEvents: number; activeMotionSensors: number; currentMean: number; currentMax: number; powerMean: number; powerMax: number; doorOpenings: number; soterInteractions: number; recognizedResidents: number; arrivals: number; departures: number }
interface Window { id: string; startAt: string; normalityIndex: number | null; anomalyScore: number | null; status: string; baselineSamples: number; reasons: string[]; features: Features }
interface Alert { id: string; observedAt: string; status: string; normalityIndex: number; reasons: string[] }
interface Overview { config: Config; health: { lastCollectionStatus?: string; lastCollectionError?: string; lastCollectedAt?: string; lastSensorIngestAt?: string; collector?: { id: string; version?: string; queueDepth?: number; lastSeenAt?: string; lastEventAt?: string; status?: string } }; windows: Window[]; alerts: Alert[] }

let firebasePromise: Promise<{ app: FirebaseApp; auth: Auth }> | undefined;
function firebase() {
  if (!firebasePromise) firebasePromise = fetch("/__/firebase/init.json").then(async (res) => {
    if (!res.ok) throw new Error("Firebase configuration is unavailable on this host.");
    const app = initializeApp(await res.json()); return { app, auth: getAuth(app) };
  });
  return firebasePromise;
}
async function api<T>(user: User, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body as T;
}

function App() {
  const [user, setUser] = useState<User | null>();
  const [fatal, setFatal] = useState("");
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has("preview");
  useEffect(() => { let stop: () => void = () => {}; void firebase().then(({ auth }) => { stop = onAuthStateChanged(auth, setUser); }).catch((e) => setFatal(e.message)); return () => stop(); }, []);
  if (preview) return <Dashboard user={{ email: "preview@local.test" } as User} previewData={mockOverview()} />;
  if (fatal) return <main className="fatal"><h1>Configuration unavailable</h1><p>{fatal}</p></main>;
  if (user === undefined) return <Loading />;
  return user ? <Dashboard user={user} /> : <Login />;
}

function Login() {
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await signInWithEmailAndPassword((await firebase()).auth, email, password); } catch (e) { setError(e instanceof Error ? e.message.replace("Firebase: ", "") : "Sign-in failed."); } finally { setBusy(false); } }
  return <main className="login-shell">
    <section className="login-story"><div className="brand-mark"><Activity /></div><div><p className="eyebrow">Soter activity intelligence</p><h1>Notice the change<br />before it becomes a concern.</h1><p className="login-copy">A calm view of movement, energy use and doorstep activity—compared with the household’s own rhythm.</p></div><p className="privacy"><ShieldCheck size={16} /> Behavioural features only. No camera images or transcripts are copied.</p></section>
    <section className="login-panel"><form onSubmit={submit}><p className="eyebrow">Restricted access</p><h2>Sign in</h2><p>Use an authorised account from the Soter updater Firebase project.</p><label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>{error && <div className="form-error">{error}</div>}<button className="primary" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button></form></section>
  </main>;
}

function Dashboard({ user, previewData }: { user: User; previewData?: Overview }) {
  const [data, setData] = useState<Overview | undefined>(previewData), [hours, setHours] = useState(168), [error, setError] = useState(""), [busy, setBusy] = useState(""), [settings, setSettings] = useState(false);
  async function refresh() { setError(""); try { setData(await api(user, `/api/overview?hours=${hours}`)); } catch (e) { setError(e instanceof Error ? e.message : "Could not load activity."); } }
  useEffect(() => { if (previewData) return; void refresh(); const timer = setInterval(() => void refresh(), 60_000); return () => clearInterval(timer); }, [hours, previewData]);
  async function action(name: string, path: string, body?: unknown) { setBusy(name); setError(""); try { await api(user, path, { method: name === "save" ? "PUT" : "POST", body: body ? JSON.stringify(body) : undefined }); await refresh(); if (name === "save") setSettings(false); } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); } finally { setBusy(""); } }
  if (!data) return error ? <main className="fatal"><h1>Could not load the dashboard</h1><p>{error}</p></main> : <Loading />;
  const latest = data.windows.at(-1), open = data.alerts.filter((a) => a.status === "open");
  const collectorOnline = !!data.health.collector?.lastSeenAt && Date.now() - new Date(data.health.collector.lastSeenAt).getTime() < 5 * 60_000;
  return <div>
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark small"><Activity /></span>Soter <b>Activity</b></a><nav><a href="#overview">Overview</a><a href="#patterns">Patterns</a><a href="#events">Events</a></nav><div className="top-actions"><button className="icon" onClick={() => setSettings(true)} aria-label="Settings"><Settings /></button><button className="avatar" onClick={async () => signOut((await firebase()).auth)}>{initials(user.email)}<LogOut /></button></div></header>
    <main id="top">{error && <div className="banner"><CircleAlert />{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      <section className="hero" id="overview"><div><p className="eyebrow">68 Grenehurst Way · household live view</p><h1>{headline(latest?.status)}</h1><p className="hero-copy">{latest?.reasons?.[0] ?? "Install the Home Assistant collector to begin learning this household’s routine."}</p><div className="status-line"><i className={data.config.enabled && collectorOnline ? "online" : "paused"} />{!data.config.enabled ? "Analysis paused" : collectorOnline ? "Monitoring" : "Collector offline"}<span />Collector {data.health.collector?.id ?? "not connected"} · seen {relative(data.health.collector?.lastSeenAt ?? data.health.lastSensorIngestAt)}</div></div><GaugeView value={latest?.normalityIndex ?? null} status={latest?.status} /></section>
      <section className="metrics"><Metric icon={<Footprints />} label="Movement" value={latest?.features.motionEvents ?? 0} suffix="events" note={`${latest?.features.activeMotionSensors ?? 0} sensors active`} /><Metric icon={<PlugZap />} label="Energy pattern" value={round(latest?.features.powerMean || latest?.features.currentMean)} suffix={latest?.features.powerMean ? "W avg" : "A avg"} note="Current 15-minute window" /><Metric icon={<DoorOpen />} label="Door activity" value={latest?.features.doorOpenings ?? 0} suffix="openings" note={`${latest?.features.soterInteractions ?? 0} Soter interactions`} /><Metric icon={<Bell />} label="Attention" value={open.length} suffix="open alerts" note={latest?.status === "learning" ? `${latest.baselineSamples} baseline windows` : "Consecutive-window filter on"} alert={open.length > 0} /></section>
      <section className="panel" id="patterns"><div className="panel-head"><div><p className="eyebrow">Learned rhythm</p><h2>Normality over time</h2></div><div className="tools"><label className="select"><Clock3 /><select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select><ChevronDown /></label><button className="secondary" disabled={!!busy} onClick={() => action("collect", "/api/collect")}><RefreshCw className={busy === "collect" ? "spin" : ""} />Refresh analysis</button></div></div>{data.windows.length ? <LineChart windows={data.windows} /> : <Empty icon={<Sparkles />} title="The baseline starts here" body="Save the entity allowlist, then install and start the Home Assistant collector." />}<div className="legend"><span><i className="green-line" />Normality index</span><span><i className="threshold" />Alert threshold {data.config.alertThreshold}</span></div></section>
      <div className="columns"><section className="panel" id="events"><div className="panel-head"><div><p className="eyebrow">Signals</p><h2>Recent activity mix</h2></div></div>{data.windows.length ? <BarChart windows={data.windows.slice(-48)} /> : <Empty icon={<Gauge />} title="No feature windows yet" body="Movement and door activity will appear here." />}<div className="legend"><span><i className="coral-block" />Movement</span><span><i className="navy-block" />Door</span></div></section>
      <section className="panel alerts"><div className="panel-head"><div><p className="eyebrow">Review</p><h2>Unusual activity</h2></div><b className="pill">{open.length} open</b></div>{data.alerts.length ? data.alerts.slice(0, 5).map((alert) => <article className={`alert ${alert.status}`} key={alert.id}><span>{alert.status === "open" ? <CircleAlert /> : <Check />}</span><div><strong>{alert.reasons[0] ?? "Unusual activity detected"}</strong><small>{dateTime(alert.observedAt)} · index {alert.normalityIndex}</small></div>{alert.status === "open" && <button onClick={() => action(`ack-${alert.id}`, `/api/alerts/${alert.id}/acknowledge`)}>Acknowledge</button>}</article>) : <Empty icon={<ShieldCheck />} title="Nothing needs attention" body="Alerts require repeated unusual windows, reducing one-off noise." />}</section></div>
      <footer><ShieldCheck /> Decision support, not an emergency or medical monitoring service. <i /> Data minimised by design</footer>
    </main>{settings && <SettingsDrawer config={data.config} busy={busy} close={() => setSettings(false)} save={(draft) => action("save", "/api/config", draft)} backfill={() => action("backfill", "/api/backfill", { days: 14 })} />}
  </div>;
}

function GaugeView({ value, status }: { value: number | null; status?: string }) { const angle = (value ?? 0) * 1.8; return <div className={`gauge ${status ?? "learning"}`} style={{ "--angle": `${angle}deg` } as React.CSSProperties}><div><strong>{value === null ? "—" : Math.round(value)}</strong><span>{value === null ? "learning" : "normality"}</span></div></div>; }
function Metric({ icon, label, value, suffix, note, alert }: { icon: ReactNode; label: string; value: string | number; suffix: string; note: string; alert?: boolean }) { return <article className={`metric ${alert ? "attention" : ""}`}><span className="metric-icon">{icon}</span><p>{label}</p><div><strong>{value}</strong><span>{suffix}</span></div><small>{note}</small></article>; }
function LineChart({ windows }: { windows: Window[] }) { const values = windows.filter((w) => w.normalityIndex !== null), width = 1000, height = 245, pad = 25; if (!values.length) return <Empty icon={<Sparkles />} title="Still learning" body="Scores appear after enough comparable windows exist." />; const points = values.map((w, i) => `${pad + i * (width - 2 * pad) / Math.max(1, values.length - 1)},${height - pad - (w.normalityIndex ?? 0) * (height - 2 * pad) / 100}`).join(" "); return <div className="chart"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#167a68" stopOpacity=".3" /><stop offset="1" stopColor="#167a68" stopOpacity="0" /></linearGradient></defs>{[0,25,50,75,100].map((v) => <line key={v} x1={pad} x2={width-pad} y1={height-pad-v*(height-2*pad)/100} y2={height-pad-v*(height-2*pad)/100} className="grid" />)}<line x1={pad} x2={width-pad} y1={height-pad-30*(height-2*pad)/100} y2={height-pad-30*(height-2*pad)/100} className="threshold-svg" /><polygon points={`${pad},${height-pad} ${points} ${width-pad},${height-pad}`} fill="url(#fill)" /><polyline points={points} className="normal-line" /></svg></div>; }
function BarChart({ windows }: { windows: Window[] }) { const max = Math.max(1, ...windows.map((w) => Math.max(w.features.motionEvents, w.features.doorOpenings))); return <div className="bars">{windows.map((w) => <div className="bar-pair" key={w.id} title={`${dateTime(w.startAt)} · movement ${w.features.motionEvents}, door ${w.features.doorOpenings}`}><i style={{ height: `${100*w.features.motionEvents/max}%` }} /><b style={{ height: `${100*w.features.doorOpenings/max}%` }} /></div>)}</div>; }
function Empty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) { return <div className="empty"><span>{icon}</span><strong>{title}</strong><p>{body}</p></div>; }

function SettingsDrawer({ config, busy, close, save, backfill }: { config: Config; busy: string; close: () => void; save: (c: Config) => void; backfill: () => void }) {
  const [draft, setDraft] = useState(config), [entities, setEntities] = useState(config.entities.map((e) => `${e.entityId},${e.kind},${e.label ?? ""}`).join("\n"));
  const update = (part: Partial<Config>) => setDraft((old) => ({ ...old, ...part }));
  const parsed = useMemo(() => entities.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [entityId, kind, label] = line.split(",").map((v) => v.trim()); return { entityId, kind: kind as Kind, label: label || undefined }; }), [entities]);
  return <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><aside className="drawer"><header><div><p className="eyebrow">Household controls</p><h2>Data connection</h2></div><button className="icon" onClick={close}><X /></button></header><div className="drawer-body"><label className="switch"><span><strong>Analysis and alerts</strong><small>Combine pushed sensor data with Soter every five minutes</small></span><input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} /></label><label>Timezone<input value={draft.timezone} onChange={(e) => update({ timezone: e.target.value })} /></label><label>Entities <small>must match the Home Assistant collector allowlist</small><textarea rows={7} value={entities} placeholder={"binary_sensor.hall_motion,motion,Hall\nsensor.kettle_power,power,Kettle"} onChange={(e) => setEntities(e.target.value)} /></label><div className="field-pair"><label>Alert below<input type="number" value={draft.alertThreshold} onChange={(e) => update({ alertThreshold: Number(e.target.value) })} /></label><label>Repeated windows<input type="number" value={draft.consecutiveWindows} onChange={(e) => update({ consecutiveWindows: Number(e.target.value) })} /></label></div><div className="field-pair"><label>Baseline days<input type="number" value={draft.baselineDays} onChange={(e) => update({ baselineDays: Number(e.target.value) })} /></label><label>Minimum samples<input type="number" value={draft.minimumBaselineWindows} onChange={(e) => update({ minimumBaselineWindows: Number(e.target.value) })} /></label></div><label className="switch"><span><strong>Alert webhook</strong><small>Send JSON only after the threshold persists</small></span><input type="checkbox" checked={draft.webhookEnabled} onChange={(e) => update({ webhookEnabled: e.target.checked })} /></label><div className="secret"><ShieldCheck /><div><strong>Outbound collector authentication</strong><p>The shared signing secret stays in Secret Manager and the HA OS app configuration.</p><code>npm run secret:ingest</code></div></div><div className="backfill"><div><strong>Rebuild the recent baseline</strong><small>The HA app recovers sensor history; this action recovers Soter and recalculates windows.</small></div><button className="secondary" disabled={!!busy} onClick={backfill}>{busy === "backfill" ? "Working…" : "Rebuild 14 days"}</button></div></div><footer><button className="secondary" onClick={close}>Cancel</button><button className="primary compact" disabled={!!busy} onClick={() => save({ ...draft, entities: parsed })}>{busy === "save" ? "Saving…" : "Save settings"}</button></footer></aside></div>;
}

function Loading() { return <div className="loading"><div className="brand-mark"><Activity /></div><span>Reading the household rhythm…</span></div>; }
const initials = (email?: string | null) => (email?.split("@")[0].split(/[._-]/).map((v) => v[0]).join("").slice(0,2) || "U").toUpperCase();
const round = (v?: number) => Number(v ?? 0).toFixed(v && v < 10 ? 1 : 0);
const relative = (value?: string | null) => { if (!value) return "not yet"; const m = Math.round((Date.now()-new Date(value).getTime())/60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m/60)} hr ago` : `${Math.floor(m/1440)} d ago`; };
const dateTime = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const headline = (status?: string) => status === "alert" ? "Something looks different." : status === "unusual" ? "Activity is outside the usual rhythm." : status === "normal" ? "The household looks on track." : "Learning what normal looks like.";

function mockOverview(): Overview {
  const now = Date.now();
  const windows: Window[] = Array.from({ length: 72 }, (_, i) => {
    const quiet = i > 67;
    return {
      id: String(i), startAt: new Date(now - (71 - i) * 15 * 60_000).toISOString(),
      normalityIndex: quiet ? 38 + i - 68 : Math.round(78 + 13 * Math.sin(i / 6)),
      anomalyScore: quiet ? 62 - i + 68 : 18, status: quiet ? "unusual" : "normal", baselineSamples: 36,
      reasons: quiet ? ["Movement was 0 (usual 4)."] : ["Activity is within the learned range for this time."],
      features: { motionEvents: quiet ? 0 : 2 + i % 5, activeMotionSensors: quiet ? 0 : 2, currentMean: 1.4 + (i % 3) * .2, currentMax: 3.2, powerMean: 0, powerMax: 0, doorOpenings: i % 17 === 0 ? 1 : 0, soterInteractions: i % 29 === 0 ? 1 : 0, recognizedResidents: i % 29 === 0 ? 1 : 0, arrivals: 0, departures: 0 },
    };
  });
  return {
    config: { enabled: true, householdId: "household-mpcck67b-epr7fs", timezone: "Europe/London", entities: [{ entityId: "binary_sensor.hall_motion", kind: "motion", label: "Hall" }], windowMinutes: 15, baselineDays: 42, minimumBaselineWindows: 24, alertThreshold: 30, consecutiveWindows: 2, webhookEnabled: false, lastCollectedAt: new Date(now - 120_000).toISOString(), soterProjectId: "doorassistant-bc50a", soterDeviceId: "e4ca4cf8b0e37b91" },
    health: { lastCollectionStatus: "ok", lastCollectedAt: new Date(now - 120_000).toISOString(), collector: { id: "haos-collector-001", version: "0.1.0", queueDepth: 0, status: "ok", lastSeenAt: new Date(now - 30_000).toISOString() } }, windows,
    alerts: [{ id: "preview-alert", observedAt: new Date(now - 3600_000).toISOString(), status: "acknowledged", normalityIndex: 24, reasons: ["Movement was 0 (usual 5)."] }],
  };
}

createRoot(document.getElementById("root")!).render(<App />);
