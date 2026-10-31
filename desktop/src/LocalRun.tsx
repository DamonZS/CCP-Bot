/*
 * The way in for a computer that has no container engine.
 *
 * CCP-Bot's stack is a database, an HTTP server, and whatever agents are connected. The container
 * route runs those as containers, which is the right answer on a machine that already has Docker —
 * and the wrong answer on one that does not, where the alternatives are a Windows feature, an
 * administrator, and a restart. This screen is what those machines get instead: the same stack as
 * programs on this computer, with a portable database unpacked into the folder once.
 *
 * It reports three facts and one running step, and nothing else. A first run downloads about 1.5 GB
 * and builds an interface, which is minutes of work with no visible progress unless the step being
 * worked on is written down — so it is, and this is where it is read.
 */

export type LocalStatus = {
  /** Whether this build can run CCP-Bot this way at all. Only Windows is wired up. */
  supported: boolean;
  /** Whether this folder is run by local mode at all. */
  wanted: boolean;
  /** The port its database listens on, once one has been chosen. */
  database_port: number | null;
  database_running: boolean;
  interface_built: boolean;
  /** What `/health` answered, when it answered at all. */
  health: number | null;
  /** The built-in Bot's port, once one has been chosen for this folder. */
  bot_port: number | null;
  /** Whether that Bot answers right now. */
  bot_health: number | null;
  address: string;
  /** The step being worked on, and what it is doing. */
  step: string;
  step_detail: string;
};

/** What the local step names mean, for the row that says which one is running. */
const STEP_LABELS: Record<string, string> = {
  runtime: "Runtime",
  database: "Database",
  dependencies: "Dependencies",
  interface: "Interface",
  schema: "Database schema",
  bot: "Built-in Bot",
  server: "Services",
  ready: "Answering",
};

export function localStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

export function LocalRun({
  status,
  busy,
  onStart,
  onStop,
}: {
  status: LocalStatus | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = status?.health != null;
  const rows = [
    {
      label: "Portable database",
      done: status?.database_running ?? false,
      // Prepared and stopped is a real state, and it is the one a returning machine is in: the
      // archive is unpacked in the folder and nothing is running yet.
      idle: status?.database_port != null && !(status?.database_running ?? false),
      detail:
        status?.database_running && status.database_port
          ? `Running on port ${status.database_port}, on this computer only.`
          : status?.database_port
            ? `Prepared (port ${status.database_port}). The first run downloads it once.`
            : "Unpacked into this folder on the first run, then reused.",
    },
    {
      label: "Interface",
      done: status?.interface_built ?? false,
      idle: true,
      detail: status?.interface_built
        ? "Built. The server serves it on the address below."
        : "Built here the first time, from the project’s own sources.",
    },
    {
      label: "Services",
      done: running,
      idle: true,
      detail: running
        ? `Answering on ${status?.address}.`
        : "The server and the connected agents, as programs on this computer.",
    },
    // The Bot is its own line because it is the one thing a checkout can be missing: a folder
    // without `agent-bot/` runs the interface and the routing perfectly well and has no coworker to
    // talk to, and this is where a person finds that out.
    {
      label: "A Bot of your own",
      done: status?.bot_health != null,
      idle: true,
      detail:
        status?.bot_health != null && status.bot_port
          ? `Answering on http://127.0.0.1:${status.bot_port}/ag-ui.`
          : status?.bot_port
            ? `Prepared (port ${status.bot_port}). It answers once the services are up.`
            : "Started with the rest, when this checkout holds the built-in Bot.",
    },
  ];
  return (
    <div className="sheet">
      <p className="steps-of">No Docker, no virtual machine, no administrator</p>
      <h1>Run CCP-Bot on this computer</h1>
      <p className="lede">
        CCP-Bot brings its own database and its own runtime, so nothing has to be installed for it
        and nothing has to be switched on in Windows. The first run takes a few minutes; later ones
        start in seconds.
      </p>
      <ol className="steps" aria-label="Local mode" aria-live="polite">
        {rows.map((row) => (
          <li className="step" key={row.label}>
            <span
              className={`mark ${row.done ? "good" : row.idle ? "idle" : "active"}`}
              aria-hidden="true"
            >
              {row.done ? "✓" : ""}
            </span>
            <span className="step-label">{row.label}</span>
            <span className="step-status">{row.done ? "Ready" : "Not yet"}</span>
            <span className="detail">{row.detail}</span>
          </li>
        ))}
        {status?.step && (
          <li className="step">
            <span className="mark active" aria-hidden="true">
              <span className="step-spinner" />
            </span>
            <span className="step-label">{localStepLabel(status.step)}</span>
            <span className="step-status">In progress</span>
            <span className="detail">{status.step_detail}</span>
          </li>
        )}
      </ol>
      <div className="row">
        {running ? (
          <button type="button" disabled={busy} onClick={onStop}>
            Stop CCP-Bot
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onStart}>
            {busy ? "Starting…" : "Start on this computer"}
          </button>
        )}
      </div>
      <p className="footnote">
        Everything it needs is unpacked into this folder the first time, so a second run works with
        no network at all. The database listens on the loopback address only.
      </p>
    </div>
  );
}