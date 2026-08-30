import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  applyNow,
  clearAgentDebug,
  fetchAgent,
  fetchAgentDebug,
  fetchCountHistory,
  fetchEvents,
  fetchLatestCounts,
  fetchPlans,
  fetchSim,
  postCount,
  recomputeAgent,
  resetSignal,
  setAgent,
  setSim,
} from "../api";
import { PhoneCamHint } from "../components/PhoneCamHint";
import { DEFAULT_SPAWN_RATE, VirtualJunction } from "../components/VirtualJunction";
import { useSignalSocket } from "../hooks/useSignalSocket";
import type {
  AgentExchange,
  LatestCounts,
  SignalEventRow,
  TimingPlanRow,
  VehicleCountRow,
} from "../types";
import { CYCLE_ORDER, SIDES } from "../types";

const SPAWN_RATE_KEY = "junction-spawn-rate";

function loadSpawnRate(): number {
  try {
    const raw = Number(localStorage.getItem(SPAWN_RATE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SPAWN_RATE;
  } catch {
    return DEFAULT_SPAWN_RATE;
  }
}

export function Dashboard() {
  const { snapshot, connected } = useSignalSocket();
  const [counts, setCounts] = useState<LatestCounts>({
    north: 0,
    east: 0,
    south: 0,
    west: 0,
  });
  const [plans, setPlans] = useState<TimingPlanRow[]>([]);
  const [events, setEvents] = useState<SignalEventRow[]>([]);
  const [history, setHistory] = useState<VehicleCountRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [simOn, setSimOn] = useState(true);
  const [agentOn, setAgentOn] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [ctrlError, setCtrlError] = useState<string | null>(null);
  const [spawnRate, setSpawnRate] = useState(loadSpawnRate);
  const [clearToken, setClearToken] = useState(0);
  const [agentLog, setAgentLog] = useState<AgentExchange[]>([]);
  const [openExchange, setOpenExchange] = useState<number | null>(null);
  // Set while a toggle request is in flight so polling can't overwrite it
  const agentPending = useRef(false);

  async function refreshMeta() {
    const [c, p, e, h, sim, agent, dbg] = await Promise.all([
      fetchLatestCounts(),
      fetchPlans(8),
      fetchEvents(12),
      fetchCountHistory(12),
      fetchSim().catch(() => ({ enabled: true })),
      fetchAgent().catch(() => null),
      fetchAgentDebug(8).catch(() => [] as AgentExchange[]),
    ]);
    setCounts(c);
    setPlans(p);
    setEvents(e);
    setHistory(h);
    setSimOn(sim.enabled);
    setAgentLog(dbg);
    if (agent && !agentPending.current) setAgentOn(agent.enabled);
  }

  useEffect(() => {
    refreshMeta();
    const t = window.setInterval(refreshMeta, 1500);
    return () => window.clearInterval(t);
  }, []);

  if (!snapshot) {
    return (
      <div className="app-frame boot">
        <p className="wordmark">SIGNAL</p>
        <p className="boot-msg">linking controllers…</p>
      </div>
    );
  }

  const t = snapshot.timings;

  // The engine calls the agent 60s before the loop wraps
  const secondsToAgentRun =
    typeof snapshot.cycle_remaining_s === "number"
      ? snapshot.cycle_remaining_s - 60
      : null;
  const agentStatusLine = !agentOn
    ? "AGENT off — SIM will not retune greens; RUN NOW still applies a plan immediately"
    : secondsToAgentRun === null
    ? "AGENT on — SIM retunes greens as queues change"
    : secondsToAgentRun <= 0
    ? "AGENT on — next-loop plan queued; live greens already follow SIM / RUN NOW"
    : `AGENT on — SIM retunes live greens; extra next-loop plan in ${Math.floor(
        secondsToAgentRun / 60
      )}m ${Math.floor(secondsToAgentRun % 60)}s`;

  return (
    <div className="app-frame split">
      <section className="junction-pane" aria-label="Virtual junction">
        <VirtualJunction
          snapshot={snapshot}
          counts={counts}
          onCountsChange={setCounts}
          spawnRate={spawnRate}
          clearToken={clearToken}
          simOn={simOn}
        />
      </section>

      <aside className="debug-pane" aria-label="Controls and debug">
        <header className="debug-head">
          <div className="wordmark-wrap">
            <p className="wordmark">SIGNAL</p>
            <p className="tag">4-way · LHT · adaptive</p>
          </div>
          <div className={`phase-pill ${connected ? "live" : ""}`}>
            <span className="phase-side">{snapshot.active_side}</span>
            <span className="phase-meta">
              {snapshot.phase.replace("_", " ")} · {snapshot.phase_remaining_s.toFixed(0)}s
              {typeof snapshot.cycle_remaining_s === "number"
                ? ` · loop ${Math.max(0, snapshot.cycle_remaining_s / 60).toFixed(1)}m left`
                : ""}
            </span>
            {snapshot.pending_plan && <span className="phase-q">queued</span>}
          </div>
        </header>

        <div className="ctrl">
          <button
            type="button"
            className={`chip ${simOn ? "on" : ""}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = !simOn;
                await setSim(next);
                setSimOn(next);
              } finally {
                setBusy(false);
              }
            }}
          >
            {simOn ? "SIM ON" : "SIM OFF"}
          </button>
          <button
            type="button"
            className={`chip ${agentOn ? "on" : ""}`}
            disabled={agentBusy}
            title="AGENT ON: SIM retunes live greens from queue counts. ~60s before the 8-minute wrap a next-loop plan is also queued (APPLY or wait for North). Slack/CLI is Agent Kernel; numbers come from the allocator."
            onClick={async () => {
              const next = !agentOn;
              agentPending.current = true;
              setAgentBusy(true);
              setCtrlError(null);
              setAgentOn(next);
              try {
                const res = await setAgent(next);
                setAgentOn(res.enabled);
              } catch (err) {
                setAgentOn(!next);
                setCtrlError(
                  err instanceof Error ? err.message : "agent toggle failed"
                );
              } finally {
                agentPending.current = false;
                setAgentBusy(false);
              }
            }}
          >
            {agentOn ? "AGENT ON" : "AGENT OFF"}
          </button>
          <button
            type="button"
            className="chip"
            disabled={busy || !snapshot.pending_plan}
            onClick={async () => {
              setBusy(true);
              try {
                await applyNow();
                await refreshMeta();
              } finally {
                setBusy(false);
              }
            }}
          >
            APPLY
          </button>
          <button
            type="button"
            className="chip ghost"
            disabled={busy || simOn}
            title={simOn ? "Turn SIM off to clear the roads" : "Remove all cars and zero queues"}
            onClick={async () => {
              setBusy(true);
              try {
                setClearToken((n) => n + 1);
                const empty: LatestCounts = {
                  north: 0,
                  east: 0,
                  south: 0,
                  west: 0,
                  tracks: { north: [], east: [], south: [], west: [] },
                };
                await Promise.all(
                  SIDES.map((s) =>
                    postCount({ side: s, vehicle_count: 0, right_count: 0, source: "manual" })
                  )
                );
                setCounts(empty);
                await refreshMeta();
              } finally {
                setBusy(false);
              }
            }}
          >
            CLEAR
          </button>
          <button
            type="button"
            className="chip ghost"
            onClick={async () => {
              await resetSignal();
              await refreshMeta();
            }}
          >
            RESET
          </button>
        </div>

        {ctrlError && <p className="ctrl-err">{ctrlError}</p>}

        <section className="debug-block">
          <h3>Spawn rate</h3>
          <label className="slider-row">
            <input
              type="range"
              min={0.25}
              max={6}
              step={0.25}
              value={spawnRate}
              onChange={(e) => {
                const next = Number(e.target.value);
                setSpawnRate(next);
                try {
                  localStorage.setItem(SPAWN_RATE_KEY, String(next));
                } catch {
                  /* ignore quota */
                }
              }}
              aria-label="Cars released per second on each approach"
            />
            <b>{spawnRate.toFixed(2)}/s</b>
          </label>
          <p className="hint">cars released onto each approach per second</p>
        </section>

        <section className="debug-block">
          <h3>Queues</h3>
          <div className="count-grid">
            {SIDES.map((s) => (
              <div key={s} className={`count-cell ${snapshot.active_side === s ? "hot" : ""}`}>
                <em>{s}</em>
                <b>{counts[s]}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="debug-block">
          <h3>Timings</h3>
          <div className="strip timings">
            {SIDES.map((s) => (
              <div key={s} className={`strip-cell ${snapshot.active_side === s ? "hot" : ""}`}>
                <span>{s[0].toUpperCase()}</span>
                <strong>{t[s].straight_s}s</strong>
                <small>R {t[s].right_s}</small>
              </div>
            ))}
          </div>
          {snapshot.pending_plan && snapshot.pending_timings && (
            <>
              <p className="hint">queued for next North wrap</p>
              <div className="strip timings queued">
                {SIDES.map((s) => (
                  <div key={s} className="strip-cell">
                    <span>{s[0].toUpperCase()}</span>
                    <strong>{snapshot.pending_timings![s].straight_s}s</strong>
                    <small>R {snapshot.pending_timings![s].right_s}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          <p className="agent-line" title={t.reason}>
            {t.reason ||
              (agentOn
                ? "Waiting for SIM or RUN NOW to retune live greens."
                : "AGENT off — live greens stay put until RUN NOW.")}
          </p>
        </section>

        <section className="debug-block">
          <div className="dbg-head">
            <h3>Agent debug</h3>
            <div className="dbg-actions">
              <button
                type="button"
                className="chip tiny"
                disabled={agentBusy}
                title="Compute from current queues and apply greens immediately"
                onClick={async () => {
                  setAgentBusy(true);
                  setCtrlError(null);
                  try {
                    await recomputeAgent();
                    await refreshMeta();
                  } catch (err) {
                    setCtrlError(
                      err instanceof Error ? err.message : "agent run failed"
                    );
                  } finally {
                    setAgentBusy(false);
                  }
                }}
              >
                RUN NOW
              </button>
              <button
                type="button"
                className="chip tiny ghost"
                onClick={async () => {
                  await clearAgentDebug();
                  setAgentLog([]);
                }}
              >
                CLEAR LOG
              </button>
            </div>
          </div>
          <p className="hint">{agentStatusLine}</p>
          <ul className="dbg-list">
            {agentLog.length === 0 && (
              <li className="muted">No exchanges yet — press RUN NOW</li>
            )}
            {agentLog.map((x) => (
              <li key={x.id} className={x.ok ? "" : "bad"}>
                <button
                  type="button"
                  className="dbg-row"
                  onClick={() =>
                    setOpenExchange(openExchange === x.id ? null : x.id)
                  }
                >
                  <span>{new Date(x.at).toLocaleTimeString()}</span>
                  <span className="dbg-tag">{x.trigger}</span>
                  <span>loop #{x.cycle_index}</span>
                  <span>{x.duration_ms.toFixed(0)}ms</span>
                  <span>{x.ok ? "ok" : "error"}</span>
                </button>
                {openExchange === x.id && (
                  <div className="dbg-detail">
                    <h4>Sent → agent</h4>
                    <table className="dbg-table">
                      <thead>
                        <tr>
                          <th>side</th>
                          <th>cars</th>
                          <th>right</th>
                          <th>through m</th>
                          <th>right m</th>
                        </tr>
                      </thead>
                      <tbody>
                        {CYCLE_ORDER.map((s) => (
                          <tr key={s}>
                            <td>{s}</td>
                            <td>{x.sent.counts[s] ?? 0}</td>
                            <td>{x.sent.right_counts[s] ?? 0}</td>
                            <td>{(x.sent.through_queue_m[s] ?? 0).toFixed(0)}</td>
                            <td>{(x.sent.right_queue_m[s] ?? 0).toFixed(0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="hint">
                      green budget {x.sent.green_pool_s.toFixed(0)}s
                    </p>

                    <h4>Received ← agent</h4>
                    {x.received ? (
                      <>
                        <table className="dbg-table">
                          <thead>
                            <tr>
                              <th>side</th>
                              <th>green</th>
                              <th>right</th>
                            </tr>
                          </thead>
                          <tbody>
                            {CYCLE_ORDER.map((s) => (
                              <tr key={s}>
                                <td>{s}</td>
                                <td>{(x.received!.straight_s[s] ?? 0).toFixed(0)}s</td>
                                <td>{(x.received!.right_s[s] ?? 0).toFixed(0)}s</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="hint">
                          cycle {(x.received.cycle_total_s / 60).toFixed(2)}m · llm{" "}
                          {x.received.llm}
                        </p>
                        <p className="dbg-reason">{x.received.reason}</p>
                      </>
                    ) : (
                      <p className="dbg-reason bad">{x.error}</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="debug-block">
          <h3>Cameras</h3>
          <PhoneCamHint />
          <div className="strip cams">
            {SIDES.map((s) => (
              <Link key={s} to={`/capture/${s}`}>
                cam/{s[0]}
              </Link>
            ))}
          </div>
        </section>

        <div className="log-cols">
          <section className="debug-block grow">
            <h3>Plans</h3>
            <ul className="log-list">
              {plans.length === 0 && <li className="muted">No plans yet</li>}
              {plans.map((p) => (
                <li key={p.id}>
                  {new Date(p.created_at).toLocaleTimeString()} — N{p.north_straight} E{p.east_straight}{" "}
                  S{p.south_straight} W{p.west_straight}
                  {p.applied_at ? " ✓" : ""}
                </li>
              ))}
            </ul>
          </section>
          <section className="debug-block grow">
            <h3>Counts</h3>
            <ul className="log-list">
              {history.length === 0 && <li className="muted">No counts yet</li>}
              {history.map((h) => (
                <li key={h.id}>
                  {new Date(h.recorded_at).toLocaleTimeString()} — {h.side} {h.vehicle_count} ({h.source})
                </li>
              ))}
            </ul>
          </section>
          <section className="debug-block grow">
            <h3>Events</h3>
            <ul className="log-list">
              {events.length === 0 && <li className="muted">No events yet</li>}
              {events.map((ev) => (
                <li key={ev.id}>
                  {new Date(ev.recorded_at).toLocaleTimeString()} — {ev.side} {ev.phase}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}
