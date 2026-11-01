import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import { StartFresh } from "./StartFresh";
import {
  DEFAULT_HARNESS,
  type HarnessChoice,
  HarnessPicker,
} from "./HarnessPicker";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { OrganizationSignIn } from "./OrganizationSignIn";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import {
  harnessChoiceEvent,
  modelChoiceEvent,
  recordSetupEvent,
  type SetupStep,
} from "./telemetry";
import { LocalRun, localStepLabel, type LocalStatus } from "./LocalRun";
import { Welcome } from "./Welcome";
import { t } from "./lib/i18n";

type EngineStatus = {
  engine: "docker" | "podman" | null;
  responding: boolean;
  engine_socket: string | null;
  detail: string;
};

type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "not-administrator";

type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
};

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
  launch?: { harness: HarnessChoice | null } | null;
  installation?: { harness: HarnessChoice | null } | null;
  autoStart?: boolean;
};

function installationKeyFor(root: string, harness: HarnessChoice | null) {
  return JSON.stringify([
    root.trim(),
    harness?.id ?? DEFAULT_HARNESS,
    harness?.agentUrl?.trim() ?? "",
  ]);
}

const MANAGED_INTELLIGENCE_API_URL = "https://api.intelligence.copilotkit.ai";
const MANAGED_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";

/**
 * Whether local mode is the right answer without being asked for.
 *
 * A machine with no engine at all cannot run the container route, and the way around it is a Windows
 * feature this account may not be allowed to switch on. Local mode needs neither, so that machine
 * starts there instead of on a requirement it cannot meet. Only that machine: with Docker or Podman
 * present the existing route keeps the decision, and "Use Docker instead" on the local screen still
 * wins afterwards. Both answers are read, because neither promise knows when the other arrives.
 */
function defaultToLocal(found: EngineStatus | null, here: LocalStatus | null) {
  return Boolean(found && here?.supported && found.engine === null && !here.wanted);
}

/**
 * What the last screen offers to ask, mirroring `ask::SUGGESTED`.
 *
 * Two copies of one sentence, and a test in `ask.rs` pins what it has to contain. The window needs
 * it before it calls anything, and the Rust side needs it for the case where somebody clears the
 * field, so neither can be the only one that has it.
 */
const SUGGESTED_QUESTION = "What is 17 times 23?";

export function App() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  /*
   * Running the stack as programs on this computer, and the choice to do it that way.
   *
   * `localPicked` is the window's copy of the decision because the folder's marker is only written
   * when a local run actually starts — and the machine has to be told which way it is going before
   * that, or it would ask for the Windows feature it is being routed around.
   */
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [localPicked, setLocalPicked] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  /*
   * Whether the local run the poll is asking about is still going.
   *
   * The window asks `local_status` once a second while a run is in flight, and an answer asked for
   * during the run can land after it has ended. A row written then has nothing left to correct it:
   * a failed run would go back to saying "in progress" and count forever beside its failure card.
   * A run that is over has said its last word about steps.
   */
  const localRunOver = useRef(true);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  const [reuseIntelligence, setReuseIntelligence] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [organizationAuthorityUrl, setOrganizationAuthorityUrl] = useState<
    string | null
  >(null);
  const [refreshOrganization, setRefreshOrganization] = useState(false);
  /*
   * Which Bot and which model, as two separate answers.
   *
   * Held here rather than inside the screens so going Back does not lose what was already chosen:
   * the flow is resumable at the screen it stopped on, and a wizard that asks twice is one nobody
   * finishes. `null` means not answered yet, which is what decides the screen below.
   */
  const [harness, setHarness] = useState<HarnessChoice | null>({
    id: DEFAULT_HARNESS,
  });
  const [model, setModel] = useState<ModelChoice | null>(null);
  /** Model credentials a previous run already wrote, so the provider screen arrives filled in. */
  const [alreadyHeld, setAlreadyHeld] = useState<HeldConfiguration>({});
  const [projects, setProjects] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [intelligenceSignInKind, setIntelligenceSignInKind] = useState<
    "managed" | "self-hosted"
  >("managed");
  const [selfHostedActive, setSelfHostedActive] = useState(false);
  const selfHostedAttempt = useRef(0);
  const selfHostedActiveRef = useRef(false);
  const cancelSelfHostedSignIn = useCallback(async () => {
    if (!selfHostedActiveRef.current) return;
    selfHostedActiveRef.current = false;
    selfHostedAttempt.current += 1;
    setSelfHostedActive(false);
    setSigningIn(false);
    setProjects(null);
    try {
      await invoke("cancel_self_hosted_intelligence_sign_in");
    } catch (error) {
      setFailure(asProblem(error));
    }
  }, []);

  async function signInToSelfHostedIntelligence() {
    await cancelSelfHostedSignIn();
    const attempt = ++selfHostedAttempt.current;
    selfHostedActiveRef.current = true;
    setSelfHostedActive(true);
    setIntelligenceSignInKind("self-hosted");
    setSigningIn(true);
    setFailure(null);
    setProjects(null);
    setApiKey("");
    setReuseIntelligence(false);
    try {
      const available = await invoke<{ id: string; name: string }[]>(
        "begin_self_hosted_intelligence_sign_in",
        { root, apiUrl },
      );
      if (selfHostedAttempt.current === attempt) setProjects(available);
    } catch (error) {
      if (selfHostedAttempt.current === attempt) {
        setFailure(asProblem(error));
        selfHostedActiveRef.current = false;
        setSelfHostedActive(false);
      }
    } finally {
      if (selfHostedAttempt.current === attempt) setSigningIn(false);
    }
  }

  /*
   * The address the browser was sent to, kept so the screen can show it.
   *
   * Both plan sign-ins already do this, for the reason written next to them: an open that silently
   * did nothing, or a machine with no registered browser, leaves somebody watching a spinner with
   * no idea where they are meant to go. This one threw the address away, so that case had no way
   * out at all.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  async function signInToCopilotKit() {
    await cancelSelfHostedSignIn();
    setIntelligenceSignInKind("managed");
    setSigningIn(true);
    setFailure(null);
    setSignInUrl(null);
    try {
      setSignInUrl(await invoke<string>("begin_intelligence_sign_in"));
      setProjects(
        await invoke<{ id: string; name: string }[]>(
          "finish_intelligence_sign_in",
        ),
      );
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setSigningIn(false);
      setSignInUrl(null);
    }
  }

  async function pickProject(id: string) {
    setSigningIn(true);
    setFailure(null);
    const selfHosted = intelligenceSignInKind === "self-hosted";
    const attempt = selfHostedAttempt.current;
    try {
      const key = await invoke<string>(
        selfHosted
          ? "finish_self_hosted_intelligence_sign_in"
          : "intelligence_key_for",
        selfHosted ? { root, project: id } : { project: id },
      );
      if (selfHosted && selfHostedAttempt.current !== attempt) return;
      setApiKey(key);
      setProjects(null);
    } catch (error) {
      if (!selfHosted || selfHostedAttempt.current === attempt) {
        setFailure(asProblem(error));
        if (selfHosted) setProjects(null);
      }
    } finally {
      if (!selfHosted || selfHostedAttempt.current === attempt) {
        setSigningIn(false);
        if (selfHosted) {
          selfHostedActiveRef.current = false;
          setSelfHostedActive(false);
        }
      }
    }
  }
  async function createProject() {
    const name = projectName.trim();
    if (!name || signingIn) return;
    setSigningIn(true);
    setCreatingProject(true);
    setFailure(null);
    try {
      const project = await invoke<{ id: string; name: string }>(
        "create_intelligence_project",
        { name },
      );
      setProjects((current) => [...(current ?? []), project]);
      setProjectName("");
      await pickProject(project.id);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setSigningIn(false);
      setCreatingProject(false);
    }
  }

  const [step, setStep] = useState<SetupStep>("welcome");
  const [apiUrl, setApiUrl] = useState(MANAGED_INTELLIGENCE_API_URL);
  const [wsUrl, setWsUrl] = useState(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const savedLaunch = useRef<string | null>(null);
  const [refreshIntelligence, setRefreshIntelligence] = useState(false);
  const [preparation, setPreparation] = useState<{
    key: string;
    status: "preparing" | "complete" | "failed";
  } | null>(null);
  const installationKey = installationKeyFor(root, harness);
  /*
   * A run on this computer is ready as soon as it is chosen.
   *
   * Step 2 prepares a container engine and eight images, and `local::start` fetches its own runtime
   * and portable database when it is started, so nothing on that step is this route's price of entry.
   * Without this, `start()` sends a local run back to Step 2 and the machine never gets to Start.
   */
  const installationReady =
    localPicked ||
    (preparation?.key === installationKey && preparation.status === "complete");
  const returningToInstallation = savedLaunch.current === installationKey;
  /*
   * Whether this folder's stack is up: the marker says it runs that way here, and the answer on the
   * port says it is running. The marker alone is what the welcome button used to follow, which left
   * it saying "running" about a stack that had been stopped.
   */
  const localStackUp = Boolean(local?.wanted && local?.health != null);
  const [running, setRunning] = useState(false);
  const visibleSetupStep =
    checkingResume ||
    resuming ||
    blockerFailure ||
    blocker ||
    (running && step !== "ask")
      ? null
      : step;
  const lastViewedStep = useRef<SetupStep | null>(null);
  useEffect(() => {
    if (visibleSetupStep === lastViewedStep.current) return;
    lastViewedStep.current = visibleSetupStep;
    if (visibleSetupStep !== null) {
      recordSetupEvent({ kind: "step_viewed", step: visibleSetupStep });
    }
  }, [visibleSetupStep]);
  const configuredRunRef = useRef(0);
  /*
   * A failure, in both registers.
   *
   * `said` is what a person reads and `detail` is the real output, kept behind a disclosure. One
   * string could not serve both: the plain sentence alone throws away the evidence, and the raw
   * engine output alone is how "pull access denied ... may require 'docker login'" ended up as the
   * headline on a setup screen. See `problem.rs`.
   */
  const [failure, setFailure] = useState<Problem | null>(null);
  // A supervisor notice belongs to the interrupted run, not to the form being hydrated.
  const [recoveryFailure, setRecoveryFailure] = useState<Problem | null>(null);
  const recoverFromStart = useCallback((error: unknown) => {
    const problem = asProblem(error);
    setSteps((current) => settleProgress(current, problem));
    setRecoveryFailure(problem);
    if (problem.connection === "model") setStep("model");
    if (problem.connection === "intelligence") {
      setRefreshIntelligence(true);
      setStep("connect");
    }
    if (problem.connection === "organization") setRefreshOrganization(true);
  }, []);
  const displayedFailure = failure ?? recoveryFailure;
  // An older shell offered only the database. The list is exactly what a reset may remove.
  const leftoverVolumes = displayedFailure?.leftover_reset?.length
    ? displayedFailure.leftover_reset
    : displayedFailure?.database_reset
      ? [displayedFailure.database_reset]
      : [];
  const leftoverContainers = displayedFailure?.leftover_containers ?? [];
  const credentialContext = useRef([
    root,
    model,
    apiKey,
    apiUrl,
    wsUrl,
    harness,
    step,
    reuseIntelligence,
  ]);
  useEffect(() => {
    const next = [
      root,
      model,
      apiKey,
      apiUrl,
      wsUrl,
      harness,
      step,
      reuseIntelligence,
    ];
    if (
      next.some((value, index) => value !== credentialContext.current[index])
    ) {
      credentialContext.current = next;
      setFailure(null);
    }
  }, [root, model, apiKey, apiUrl, wsUrl, harness, step, reuseIntelligence]);

  const clearRootScopedSavedState = useCallback(() => {
    void cancelSelfHostedSignIn();
    setIntelligenceSignInKind("managed");
    savedLaunch.current = null;
    setRefreshIntelligence(false);
    setRefreshOrganization(false);
    setOrganizationAuthorityUrl(null);
    setApiKey("");
    setReuseIntelligence(false);
    setApiUrl(MANAGED_INTELLIGENCE_API_URL);
    setWsUrl(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
    setAlreadyHeld({});
  }, [cancelSelfHostedSignIn]);

  const loadConfiguredRoot = useCallback(
    async (nextRoot: string) => {
      const trimmedRoot = nextRoot.trim();
      const run = configuredRunRef.current + 1;
      configuredRunRef.current = run;
      clearRootScopedSavedState();
      if (!trimmedRoot) return;
      try {
        const configured = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: trimmedRoot },
        );
        if (configuredRunRef.current !== run) return;
        const { values, saved } = configured;
        if (values.INTELLIGENCE_API_KEY) setApiKey(values.INTELLIGENCE_API_KEY);
        if (values.INTELLIGENCE_API_URL) setApiUrl(values.INTELLIGENCE_API_URL);
        if (values.INTELLIGENCE_GATEWAY_WS_URL)
          setWsUrl(values.INTELLIGENCE_GATEWAY_WS_URL);
        setAlreadyHeld({ ...values, saved });
        setOrganizationAuthorityUrl(
          values.CCPBOT_ORGANIZATION_AUTH_URL ?? null,
        );
        return configured;
      } catch {
        if (configuredRunRef.current === run) {
          setAlreadyHeld({});
        }
      }
    },
    [clearRootScopedSavedState],
  );

  /**
   * The one place local mode is chosen without being asked for.
   *
   * A machine with no engine at all cannot run the container route, and the way around it is a
   * Windows feature this account may not be allowed to switch on. Local mode needs neither, so that
   * machine starts there instead of on a requirement it cannot meet. Only that machine: with Docker
   * or Podman present the existing route keeps the decision, and "Use Docker instead" on the local
   * screen still wins afterwards.
   *
   * Both answers are read in the promise that fetched them rather than in an effect over them, so the
   * choice lands in the same render as the answer it was made from instead of costing the window an
   * extra pass before it can draw.
   */
  const localAnswer = useRef<LocalStatus | null>(null);
  const engineAnswer = useRef<EngineStatus | null>(null);

  useEffect(() => {
    let active = true;
    invoke<EngineStatus>("detect_engine")
      .then((found) => {
        if (!active) return;
        engineAnswer.current = found;
        setEngine(found);
        if (defaultToLocal(found, localAnswer.current)) setLocalPicked(true);
      })
      .catch(() => undefined);
    // Local mode is read here rather than at the moment somebody asks for it: a machine that has run
    // this way before should not be shown a Windows requirement it already chose its way around.
    invoke<LocalStatus>("local_status")
      .then((found) => {
        if (!active) return;
        localAnswer.current = found;
        setLocal(found);
        if (found.wanted || defaultToLocal(engineAnswer.current, found)) {
          setLocalPicked(true);
        }
      })
      .catch(() => undefined);
    const windowsReady = invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
        setBlocker(found);
        if (found) {
          setInstruction(
            await invoke<string>("windows_blocker_instruction", {
              blocker: found,
            }),
          );
        }
        return found === null;
      })
      .catch((error) => {
        setBlockerFailure(asProblem(error));
        return false;
      });
    // A supervisor that stopped retrying must stay stopped when it returns to this window.
    const interruptedRun = invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) setRecoveryFailure(found);
        return found;
      })
      .catch(() => null);
    Promise.all([
      invoke<string | null>("selected_root").catch(() => null),
      invoke<string>("default_root"),
      windowsReady,
      interruptedRun,
    ])
      .then(async ([selected, fallback, canResume, interrupted]) => {
        if (!active) return;
        const found = selected || fallback;
        setRoot(found);
        /*
         * Arrive filled in when a previous run already wrote these.
         *
         * The alternative is asking somebody to find a key again, and "find it again" means opening
         * a dotfile in a text editor — the exact thing this product exists not to require. Their own
         * file, read back to them on their own machine.
         */
        const configured = await loadConfiguredRoot(found);
        if (!active) return;
        const installed = configured?.launch ?? configured?.installation;
        const resumedModel = configured
          ? recordedModel({
              ...configured.values,
              saved: configured.saved,
            })
          : null;
        if (installed) {
          const key = installationKeyFor(found, installed.harness);
          setHarness(installed.harness);
          setModel(resumedModel);
          setPreparation({ key, status: "complete" });
          if (configured?.launch) savedLaunch.current = key;
          setStep(resumedModel ? "connect" : "model");
        }
        if (interrupted?.connection) {
          recoverFromStart(interrupted);
          return;
        }
        /*
         * A folder that runs this stack as programs on this computer answers for itself.
         *
         * The marker says this folder has run that way and the port says the stack is up now. Neither
         * is a launch intent, and the local route writes no such record: the container route's own
         * answers below cannot recognise this stack, so a window opened on one it is already serving
         * would offer to set the whole thing up again — and the Stop on the screen that follows would
         * be the one place it could not be reached from.
         */
        const localStack = await invoke<LocalStatus>("local_status").catch(
          () => null,
        );
        if (!active) return;
        if (localStack?.wanted && !configured?.launch) {
          setLocal(localStack);
          setLocalPicked(true);
          setRecoveryFailure(null);
          if (localStack.health != null) {
            // Up now: what is missing is the window, not the stack.
            setRunning(true);
            await invoke("show_ccpbot");
            return;
          }
          // Marked and stopped. This folder is not a fresh wizard, and its own screen carries the
          // Start that knows how to start it. The harness is the record's when there is one and the
          // default otherwise — the same pair the render builds this key from — read as a value
          // rather than as state, which this check must not re-run whenever somebody changes it.
          savedLaunch.current = installationKeyFor(
            found,
            installed?.harness ?? { id: DEFAULT_HARNESS },
          );
          setStep(resumedModel ? "connect" : "model");
          return;
        }
        // A stack this app started may still be up from a previous window. Ask, rather than
        // offering to set up something that is already running.
        if (
          await invoke<boolean>("already_running", { root: found }).catch(
            () => false,
          )
        ) {
          // Already up from a previous window: show it, rather than a screen about it.
          await invoke("show_ccpbot");
          setRunning(true);
          return;
        }
        if (!active || !canResume || !configured?.launch || !resumedModel)
          return;
        const resumedHarness = configured.launch.harness;
        // An interrupted run needs an explicit Start, with its saved setup still available.
        if (interrupted || configured.autoStart === false) return;
        /*
         * A folder that runs this stack as programs on this computer is not opened with
         * `start_stack`: that is the container route, and a machine that runs it this way has no
         * engine for it. `local_status` is what knows the folder — and it also answers whether the
         * stack is already up, in which case what is missing is the window, not the stack.
         */
        const localHere = await invoke<LocalStatus>("local_status").catch(
          () => null,
        );
        if (!active) return;
        if (localHere?.wanted) {
          setLocal(localHere);
          if (localHere.health == null) return;
          setRunning(true);
          setRecoveryFailure(null);
          await invoke("show_ccpbot");
          return;
        }
        setBusy(true);
        setResuming(true);
        try {
          // Only a successful previous setup supplies launch intent. Reopening uses its saved
          // connections and already installed assets; the native start still validates both.
          await invoke("start_stack", {
            root: found,
            apiKey: "",
            apiUrl:
              configured.values.INTELLIGENCE_API_URL ||
              MANAGED_INTELLIGENCE_API_URL,
            gatewayWsUrl:
              configured.values.INTELLIGENCE_GATEWAY_WS_URL ||
              MANAGED_INTELLIGENCE_GATEWAY_WS_URL,
            model: resumedModel,
            harness: resumedHarness,
            ...(configured.values.CCPBOT_ORGANIZATION_AUTH_URL
              ? {
                  organizationAuthUrl:
                    configured.values.CCPBOT_ORGANIZATION_AUTH_URL,
                }
              : {}),
          });
          if (!active) return;
          setSteps((current) => settleProgress(current));
          setRunning(true);
          setRecoveryFailure(null);
          await invoke("show_ccpbot");
        } catch (error) {
          if (active) recoverFromStart(error);
        } finally {
          if (active) {
            setBusy(false);
            setResuming(false);
          }
        }
      })
      .catch((error) => {
        if (active) recoverFromStart(error);
      })
      .finally(() => {
        if (active) setCheckingResume(false);
      });
    const stop = listen<Progress>("setup:progress", (event) => {
      // One row per step, updated in place. A step that reports twice is the same step saying
      // more, and a list that grows a line each time reads as a log rather than as progress.
      setSteps((current) => {
        const at = current.findIndex(
          (step) => step.step === event.payload.step,
        );
        if (at === -1) return [...current, event.payload];
        const next = [...current];
        next[at] = event.payload;
        return next;
      });
    });
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
    };
  }, [loadConfiguredRoot, recoverFromStart]);

  /*
   * What a local start is doing, while it is doing it.
   *
   * A first run takes minutes and the machine reports nothing on its own, so the step being worked
   * on is asked for instead: `local_status` answers with the one the run is on, and the progress
   * list is where the container route says the same kind of thing. The asking stops with the run,
   * because this effect ends when `localBusy` does.
   */
  useEffect(() => {
    if (!localPicked || !localBusy) return;
    let active = true;
    const ask = () =>
      invoke<LocalStatus>("local_status")
        .then((found) => {
          if (!active) return;
          setLocal(found);
          // Too late to describe a run that is over: the row written here would tick forever.
          if (!found.step || localRunOver.current) return;
          // One row, updated in place: this is a run working through a list of steps, not a log.
          // The name is the one `LocalRun` shows for the same id — one table, from where it already
          // lives — because this row and that screen describe the same run. The detail beside it
          // stays as the run wrote it: those sentences are the machine's own words, not a label.
          setSteps([
            {
              step: localStepLabel(found.step),
              ok: found.health != null,
              running: found.health == null,
              detail: found.step_detail,
            },
          ]);
        })
        .catch(() => undefined);
    void ask();
    const timer = setInterval(() => void ask(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [localBusy, localPicked]);

  

  /*
   * The keyboard way out, the same way as the menu bar's.
   *
   * The window menu's own shortcut never reaches this window on Windows: the key arrives at the
   * page and the menu's accelerator does not fire (`docs/local-mode.md`, pit 18). So the key is
   * read here and handed to the command the menu item runs, rather than a second way of shutting
   * down: whatever `Quit` does, this does.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "q") return;
      invoke("quit_ccpbot").catch((error) => recoverFromStart(error));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recoverFromStart]);

  /*
   * Starts the local stack, then hands the window over.
   *
   * The same handover as the container route and for the same reason: `show_ccpbot` is what turns
   * this window into CCP-Bot, and it will not do it until something answers on the address.
   */
  async function runLocally(nextModel: ModelChoice | null = model) {
    if (localBusy) return;
    setLocalBusy(true);
    localRunOver.current = false;
    setFailure(null);
    // What is on screen between this click and the machine's first answer. A warm run is seconds
    // long end to end, so without this row the screen a person watches a start on can say nothing
    // for as long as the start lasts. The name is the one this route's own first step maps to, taken
    // from the same table as every other row, so it is the name the machine itself would give it.
    setSteps([
      {
        step: localStepLabel("checkout"),
        ok: false,
        running: true,
        detail: "",
      },
    ]);
    setLocalPicked(true);
    try {
      const found = await invoke<LocalStatus>("local_start", {
        // The CopilotKit connection, because a local run writes its own `.env` and the server
        // refuses to start without either that or an identity provider.
        //
        // The folder travels with the request too: the wizard can be pointed somewhere other than the
        // default root, and the stack that starts has to be the one the person is looking at.
        //
        // The model answer travels with them as a whole, not as a bare key: the built-in Bot is a
        // process that reads its credential out of the environment, so the provider, the endpoint
        // and the key the person typed on the model screen are the difference between a Bot that
        // answers and one that cannot start at all. The container route sends the same object.
        request: {
          root: root.trim(),
          apiUrl,
          gatewayWsUrl: wsUrl,
          apiKey,
          model: nextModel,
        },
      });
      setLocal(found);
      setRunning(true);
      savedLaunch.current = installationKey;
      setStep("connect");
      setRefreshIntelligence(false);
      await invoke("show_ccpbot");
    } catch (error) {
      const problem = asProblem(error);
      localRunOver.current = true;
      setFailure(problem);
      // The row stops claiming to be working on something the moment nothing is.
      setSteps((current) => settleProgress(current, problem));
      // The step that failed is worth keeping on screen afterwards: it names the part that needs
      // attention, which the failure sentence alone does not.
      setLocal(await invoke<LocalStatus>("local_status").catch(() => null));
    } finally {
      localRunOver.current = true;
      setLocalBusy(false);
    }
  }

  async function stopLocally() {
    if (localBusy) return;
    setLocalBusy(true);
    setFailure(null);
    try {
      setLocal(await invoke<LocalStatus>("local_stop"));
      setRunning(false);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setLocalBusy(false);
    }
  }

  /*
   * Which folder a Bot works in. The command opens the folder dialog itself, so the window does not
   * have to know how folders are chosen here, and it answers with the same status the rest of this
   * screen reads: one shape of truth, one place it comes from.
   */
  async function chooseWorkspace() {
    if (localBusy) return;
    setLocalBusy(true);
    setFailure(null);
    try {
      setLocal(await invoke<LocalStatus>("local_choose_workspace"));
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setLocalBusy(false);
    }
  }

  async function install() {
    if (busy || !root.trim()) return;
    // This preparation is a container engine and eight images, and a machine running the stack as
    // ordinary processes has neither to fetch: `local::start` downloads its own runtime and database
    // when it is started. So this action belongs to the container route, and nothing local reaches it.
    if (localPicked) return;
    setBusy(true);
    setFailure(null);
    setSteps([
      {
        step: "engine",
        ok: true,
        running: true,
        detail: "Checking the software CCP-Bot needs.",
      },
    ]);
    setPreparation({ key: installationKey, status: "preparing" });
    try {
      await invoke("prepare_installation", { root: root.trim(), harness });
      setSteps((current) => settleProgress(current));
      setPreparation({ key: installationKey, status: "complete" });
    } catch (error) {
      const problem = asProblem(error);
      setSteps((current) => settleProgress(current, problem));
      setPreparation({ key: installationKey, status: "failed" });
      setFailure(problem);
    } finally {
      setBusy(false);
    }
  }

  async function start(nextModel = model) {
    if (!installationReady) {
      setStep("install");
      return;
    }
    /*
     * Local mode starts the same stack with different plumbing.
     *
     * Everything below this line is about engines, ports and images, and none of it applies to a
     * run that is two `bun` processes and a database in the folder — so the decision is made here,
     * once, rather than through `if (local)` branches down the whole of the container route.
     */
    if (localPicked) {
      await runLocally(nextModel);
      return;
    }
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
        root: root.trim(),
        apiUrl,
        gatewayWsUrl: wsUrl,
        apiKey,
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made `ANTHROPIC_API_KEY` and a plan token
        // expressible at the same time.
        model: nextModel,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness,
        ...(organizationAuthorityUrl !== null
          ? { organizationAuthUrl: organizationAuthorityUrl }
          : {}),
      });
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      // Refreshing credentials does not turn an existing installation into a first run.
      if (
        savedLaunch.current === installationKey ||
        organizationAuthorityUrl?.trim()
      ) {
        savedLaunch.current = installationKey;
        setStep("connect");
        setRefreshIntelligence(false);
        await invoke("show_ccpbot");
        return;
      }
      /*
       * One screen short of the handover, on purpose.
       *
       * The window used to become CCP-Bot here, the moment the stack was up. But up is not the
       * same as working: a refused key or a lapsed plan gives a stack that starts clean and a Bot
       * that cannot answer, and handing over at this point means somebody discovers that inside
       * the product with no idea which of their answers caused it. So the last screen asks a
       * question, and the handover waits for an answer to come back.
       */
      setStep("ask");
    } catch (error) {
      recoverFromStart(error);
    } finally {
      setBusy(false);
      invoke<EngineStatus>("detect_engine")
        .then(setEngine)
        .catch(() => undefined);
    }
  }

  /** The leftovers go first, then Start carries on: starting fresh is one choice, not two. */
  async function startFresh(volumes: string[], containers: string[]) {
    setBusy(true);
    try {
      await invoke("reset_leftover_database", {
        root: root.trim(),
        volumes,
        containers,
        confirmed: true,
      });
    } catch (error) {
      setFailure(asProblem(error));
      return;
    } finally {
      // `start` sets `busy` itself, and its early return would never clear it.
      setBusy(false);
    }
    setFailure(null);
    setRecoveryFailure(null);
    setSteps([]);
    await start();
  }

  function modelCanStart() {
    if (!model) return false;
    if (!model.saved) return true;
    if (model.provider === "google" || model.provider === "xai") {
      return model.login === "oauth" && Boolean(model.model?.trim());
    }
    if (model.provider === "openai-compatible") {
      return (
        model.login === "endpoint" &&
        isHttpEndpointUrl(model.baseUrl ?? "") &&
        Boolean(model.model?.trim())
      );
    }
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      return false;
    }
    return model.login === "plan" || model.login === "api-key";
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("connect");
      setRefreshIntelligence(false);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeModelAfterAskFailure() {
    setBusy(true);
    setFailure(null);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("model");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
  if (blockerFailure) {
    return (
      <main>
        <h1>{t("CCP-Bot could not check Windows setup")}</h1>
        <Failure problem={blockerFailure} />
      </main>
    );
  }

  if (blocker && !localPicked) {
    return (
      <main>
        <h1>{t("CCP-Bot needs one thing first")}</h1>
        <div className="blocker">
          <h2>{titleFor(blocker)}</h2>
          <p>{instruction}</p>
        </div>
        <p className="lede">
          {t("Or run CCP-Bot on this computer instead. It brings its own database and its own runtime, so it needs no administrator, nothing switched on in Windows, and nothing installed first.")}
        </p>
        <div className="row">
          <button
            type="button"
            disabled={localBusy}
            onClick={() => {
              setLocalPicked(true);
              setStep("welcome");
            }}
          >
            {t("Run it on this computer")}
          </button>
        </div>
      </main>
    );
  }

  if (resuming || checkingResume) {
    return (
      <main>
        <h1>{resuming ? t("Starting CCP-Bot") : t("Opening CCP-Bot")}</h1>
        <p role="status">
          {resuming
            ? t("Opening your saved setup…")
            : t("Checking your saved setup…")}
        </p>
        <SetupProgress steps={steps} />
      </main>
    );
  }

  if (refreshOrganization) {
    return (
      <main>
        <OrganizationSignIn
          root={root}
          authorityUrl={organizationAuthorityUrl ?? ""}
          onBack={() => {
            setRefreshOrganization(false);
            setRefreshIntelligence(true);
            setRunning(false);
          }}
          onSignedIn={async () => {
            try {
              await invoke("show_ccpbot");
              setRefreshOrganization(false);
              setRecoveryFailure(null);
              setRunning(true);
            } catch (error) {
              recoverFromStart(error);
            }
          }}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  /*
   * Install local software before showing either sign-in. A completed installation is retained
   * while somebody changes or retries their connection; changing its folder or Bot invalidates it.
   *
   * Skipped entirely when a stack is already up: somebody returning to a running CCP-Bot is not
   * setting one up, and asking them to pick a Bot again would be the wizard asking twice.
   */
  if (!running && step === "welcome") {
    return (
      <main>
        <Welcome onStart={() => setStep("harness")} />
        {/*
          The other way to run the same stack, offered before the wizard rather than buried in it:
          a machine with no container engine should not have to walk all four screens to find this
          out, and a machine that has one may still prefer it.
        */}
        <div className="row">
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              /*
               * Asked rather than assumed. This window may have been sitting on this screen since
               * before the stack was started — by the menu bar, or by a window that was closed —
               * and walking into the wizard then would start a second stack over the first.
               */
              void (async () => {
                const found = await invoke<LocalStatus>("local_status").catch(
                  () => null,
                );
                if (found) setLocal(found);
                if (found?.wanted && found.health != null) {
                  setLocalPicked(true);
                  setRunning(true);
                  try {
                    await invoke("show_ccpbot");
                  } catch (error) {
                    recoverFromStart(error);
                  }
                  return;
                }
                setLocalPicked(true);
                setStep("harness");
              })();
            }}
          >
            {localStackUp
              ? t("Running on this computer")
              : t("Run it on this computer instead")}
          </button>
        </div>
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && step === "harness") {
    return (
      <main>
        <HarnessPicker
          chosen={harness}
          onChoose={(choice) => {
            if (
              choice.id !== harness?.id ||
              choice.agentUrl !== harness?.agentUrl
            ) {
              setPreparation(null);
              setSteps([]);
            }
            setHarness(choice);
          }}
          onContinue={() => {
            recordSetupEvent(
              harnessChoiceEvent(harness?.id ?? DEFAULT_HARNESS),
            );
            setHarness((choice) =>
              choice?.id === "byo-url"
                ? { ...choice, agentUrl: choice.agentUrl?.trim() }
                : choice,
            );
            setStep("install");
          }}
          onBack={() => setStep("welcome")}
        />
      </main>
    );
  }

  if (!running && step === "install") {
    return (
      <main>
        <div className="sheet">
          <p className="steps-of">{t("Step 2 of 4")}</p>
          <h1>
            {localPicked
              ? t("Nothing to install on this computer")
              : installationReady
                ? "Installation complete"
                : "Install CCP-Bot"}
          </h1>
          <p className="lede">
            {localPicked
              ? t("This step fetches nothing. The first Start prepares the runtime, the portable database, the interface and its schema itself, then serves them from this folder.")
              : installationReady
                ? "CCP-Bot’s local software is ready. Next, connect your AI and CopilotKit accounts."
                : "Install the software CCP-Bot needs on this computer. This can take a few minutes. You’ll sign in after installation finishes."}
          </p>
          {!installationReady && engine?.responding && (
            <p className="footnote">
              {t("Using")} {engine.engine === "docker" ? t("Docker") : t("Podman")} {t("for local services.")}
            </p>
          )}
          <div className="field">
            <label htmlFor="root">{t("Where CCP-Bot lives")}</label>
            <input
              id="root"
              disabled={busy}
              value={root}
              onChange={(event) => {
                configuredRunRef.current += 1;
                setRoot(event.target.value);
                setModel(null);
                setPreparation(null);
                setSteps([]);
                clearRootScopedSavedState();
              }}
              onBlur={(event) => loadConfiguredRoot(event.target.value)}
              spellCheck={false}
            />
          </div>
          <SetupProgress steps={steps} />
          {displayedFailure && <Failure problem={displayedFailure} />}
          {busy && <p role="status">{t("Installing local software…")}</p>}
          {/* Nothing to repair on this computer: the local route installs at Start, and this block's
            one action would be the container preparation `install()` refuses to run. */}
          {installationReady && !localPicked && (
            <details>
              <summary>{t("Installation options")}</summary>
              <button type="button" className="quiet" onClick={install}>
                {t("Repair installation")}
              </button>
            </details>
          )}
          <div className="row">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setStep("harness")}
            >
              {t("Back")}
            </button>
            {installationReady ? (
              <button
                type="button"
                onClick={() => {
                  setSteps([]);
                  setStep("model");
                }}
              >
                {localPicked ? t("Continue") : t("Continue to sign in")}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !root.trim()}
                onClick={install}
              >
                {busy
                  ? t("Installing…")
                  : preparation?.status === "failed"
                    ? "Retry installation"
                    : "Install CCP-Bot"}
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  /*
   * Shown while the stack is running, which every other screen is skipped for. This is the one
   * screen that needs a running stack: it is the proof, and there is nothing to ask before there
   * is something to ask.
   */
  if (step === "ask") {
    return (
      <main>
        <Ask
          suggestion={SUGGESTED_QUESTION}
          onAsk={(question) =>
            invoke<string>("ask_the_bot", { root, question })
          }
          onOpen={() => {
            savedLaunch.current = installationKey;
            invoke("show_ccpbot").catch((error) => recoverFromStart(error));
          }}
          onBack={changeModelAfterAskFailure}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && step === "model") {
    return (
      <main>
        <ProviderPicker
          held={alreadyHeld}
          root={root}
          chosen={model}
          returning={returningToInstallation}
          /*
           * A local run started from this screen is a start like any other: minutes of work, and the
           * screen has to say so. It is reported through `localBusy`, which is why it is folded into
           * the same flag the container route uses — a button that stays solid over a start already
           * running answers a second click with nothing at all.
           */
          busy={busy || localBusy}
          onChoose={(choice) => {
            recordSetupEvent(modelChoiceEvent(choice));
            setModel(choice);
            if (returningToInstallation) void start(choice);
            else setStep("connect");
          }}
          onBack={() => {
            setSteps([]);
            setStep(returningToInstallation ? "connect" : "install");
          }}
        />
        {/* What that start is doing, in the same rows the other screens use. */}
        {localBusy && <SetupProgress steps={steps} />}
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && returningToInstallation && (!refreshIntelligence || localPicked)) {
    /*
     * A machine set up for local mode gets the local screen, which carries its own Start and Stop
     * and says what the two processes and the database are doing. The container route's Start button
     * would be a promise this machine cannot keep: there is no engine here to start anything with.
     *
     * A run on this computer never comes through here to refresh a connection either — it has none
     * to refresh, and the container's refresh screen is the one screen this route must not show.
     */
    if (localPicked) {
      return (
        <main>
          <LocalRun
            status={local}
            busy={localBusy}
            onStart={() => void runLocally()}
            onStop={stopLocally}
            onChooseWorkspace={chooseWorkspace}
          />
          <SetupProgress steps={steps} />
          {displayedFailure && <Failure problem={displayedFailure} />}
          <button
            type="button"
            className="quiet"
            disabled={localBusy}
            onClick={() => {
              setLocalPicked(false);
              setStep("model");
            }}
          >
            {t("Use Docker instead")}
          </button>
        </main>
      );
    }
    return (
      <main>
        <h1>{t("CCP-Bot is stopped")}</h1>
        <p className="lede">
          {t("Your installation and saved connections are ready to reopen.")}
        </p>
        <SetupProgress steps={steps} />
        {displayedFailure && <Failure problem={displayedFailure} />}
        <button
          type="button"
          disabled={busy || !installationReady || !modelCanStart()}
          onClick={() => start()}
        >
          {busy ? t("Starting…") : t("Start CCP-Bot")}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setStep("model")}
        >
          {t("Change AI connection")}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setRefreshIntelligence(true)}
        >
          {t("Change CopilotKit connection")}
        </button>
        {displayedFailure && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={install}
          >
            {t("Repair installation")}
          </button>
        )}
        <details>
          <summary>{t("Installation options")}</summary>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              setPreparation(null);
              setSteps([]);
              setStep("install");
            }}
          >
            {t("Change installation")}
          </button>
        </details>
      </main>
    );
  }

  return (
    <main>
      <div className="sheet connection-sheet">
        {/* A failure outranks `running`. The supervisor gives up on a process and sends the window
          back here, and a heading that still says everything is running while the box underneath
          names the process that stopped is a screen arguing with itself. */}
        {!running && leftoverVolumes.length > 0 && (
          <StartFresh
            key={`${root}:${leftoverVolumes.join(",")}:${leftoverContainers.join(",")}`}
            busy={busy}
            containers={leftoverContainers}
            database={Boolean(displayedFailure?.database_reset)}
            volumes={leftoverVolumes}
            onStartFresh={startFresh}
          />
        )}

        <h1>
          {running && !displayedFailure
            ? t("CCP-Bot is running")
            : localPicked
              ? "Run CCP-Bot on this computer"
              : returningToInstallation
                ? "Refresh your CopilotKit connection"
                : t("Start CCP-Bot")}
        </h1>
        <p className="lede">
          {running && !displayedFailure
            ? t("The stack is up. CCP-Bot is in this window; the menu bar has it too, and stops it.")
            : localPicked
              ? t("This stack runs on this computer and keeps its conversations in its own database, so no CopilotKit connection is needed.")
              : returningToInstallation
                ? "Update this connection to reopen your existing CCP-Bot."
                : t("Installation is complete. Start CCP-Bot — a CopilotKit connection is optional.")}
        </p>

        {/*
          The connection form belongs to the container route. A run on this computer has nowhere to
          put a platform connection and nothing that would use one, so offering a sign-in here — or
          reporting one this root already holds — would be a promise this route does not keep. What a
          local deployment can be pointed at lives in its own `.env`, which the wizard says nothing
          about; `docs/local-mode.md` has the one paragraph.
        */}
        {!running && !localPicked && (
          <fieldset className="connection-form" disabled={busy}>
            {/*
            Sign in on the main path; paste behind the disclosure.

            This screen used to ask for a key whose only source was two terminal commands, which is
            the one thing the audience rule forbids. Somebody on managed CopilotKit now signs in and
            CCP-Bot creates the key for the project they pick. Somebody running their own
            Intelligence has a key this sign-in knows nothing about, so the field moves down there
            with the addresses it belongs with.
          */}
            {apiKey && !signingIn && !projects ? (
              <>
                <p className="lede">
                  {intelligenceSignInKind === "self-hosted"
                    ? t("Connected to Intelligence.")
                    : t("Connected to CopilotKit.")}
                </p>
                {returningToInstallation && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={signInToCopilotKit}
                  >
                    {t("Sign in to CopilotKit again")}
                  </button>
                )}
              </>
            ) : (alreadyHeld.saved?.intelligenceApiKey || reuseIntelligence) &&
              !signingIn &&
              !projects ? (
              <>
                <p className="lede">
                  {t("A saved CopilotKit connection will be checked when you start.")}
                </p>
                <button
                  type="button"
                  className="quiet"
                  onClick={signInToCopilotKit}
                >
                  {t("Sign in to CopilotKit again")}
                </button>
              </>
            ) : signInUrl ? (
              <>
                <p className="lede">
                  {t("Finish signing in to CopilotKit in your browser. If it did not open, this is the address:")}
                </p>
                {/* Selectable text, not a link: the browser has already been asked to open it, and
                  what is needed here is something a person can copy. */}
                <p className="footnote" style={{ userSelect: "text" }}>
                  {signInUrl}
                </p>
                <p className="footnote">{t("Waiting for you to approve it…")}</p>
              </>
            ) : projects ? (
              <>
                <p className="lede">{t("Which project should CCP-Bot use?")}</p>
                <fieldset className="picker">
                  <legend className="sr-only">{t("Project")}</legend>
                  {projects.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      className="tile project-choice"
                      disabled={signingIn}
                      onClick={() => pickProject(project.id)}
                    >
                      <span className="tile-name">{project.name}</span>
                    </button>
                  ))}
                </fieldset>
                {projects.length === 0 && (
                  <>
                    <p className="footnote">
                      {intelligenceSignInKind === "self-hosted"
                        ? t("That account has no available projects. Ask your Intelligence administrator for access, or sign in with a different account.")
                        : t("That account has no projects yet. Create one below, or sign in with a different account.")}
                    </p>
                    <button
                      type="button"
                      className="quiet"
                      disabled={signingIn}
                      onClick={
                        intelligenceSignInKind === "self-hosted"
                          ? signInToSelfHostedIntelligence
                          : signInToCopilotKit
                      }
                    >
                      {signingIn
                        ? t("Waiting for your browser…")
                        : t("Sign in again")}
                    </button>
                  </>
                )}
                {intelligenceSignInKind === "managed" && (
                  <form
                    className="new-project-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createProject();
                    }}
                  >
                    <div className="field">
                      <label htmlFor="new-project-name">{t("New project name")}</label>
                      <input
                        id="new-project-name"
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        disabled={signingIn}
                        autoComplete="off"
                      />
                    </div>
                    <button
                      type="submit"
                      className={projects.length > 0 ? "quiet" : undefined}
                      disabled={signingIn || !projectName.trim()}
                    >
                      {creatingProject ? t("Creating project…") : t("Create project")}
                    </button>
                  </form>
                )}
              </>
            ) : (
              <>
                <p className="lede">
                  {t("CCP-Bot keeps your conversations in CopilotKit. Sign in and it sets the rest up for you.")}
                </p>
                <div className="row connection-actions">
                  <button
                    type="button"
                    disabled={signingIn}
                    onClick={signInToCopilotKit}
                  >
                    {signingIn
                      ? t("Waiting for your browser…")
                      : t("Sign in to CopilotKit")}
                  </button>
                  {!apiKey &&
                    !reuseIntelligence &&
                    alreadyHeld.saved?.intelligenceApiKey == null &&
                    !signingIn && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setReuseIntelligence(true)}
                      >
                        {t("Use a saved connection")}
                      </button>
                    )}
                </div>
              </>
            )}
            {/*
            This used to be headed "Self-hosted Intelligence" over two fields pre-filled with the
            MANAGED service's addresses, which says the opposite of what it does: somebody opening
            it to check where their data goes read "self-hosted" and saw CopilotKit's own hosts.
            The heading now describes the action, and the note says what the defaults are.
          */}
            <details>
              <summary>{t("Point at your own Intelligence server")}</summary>
              <p className="footnote" style={{ margin: "0.6rem 0 0.75rem" }}>
                {t("Enter your Intelligence server’s addresses, then sign in to choose a project. CCP-Bot creates its Learning container for you. Sign-in requires Chrome or Microsoft Edge. You can also use an existing project key.")}
              </p>
              <div className="field">
                <label htmlFor="key">{t("Project key")}</label>
                <input
                  id="key"
                  disabled={selfHostedActive}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={t("the key from your own Intelligence")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="field" style={{ marginTop: "0.75rem" }}>
                <label htmlFor="api">{t("API URL")}</label>
                <input
                  id="api"
                  disabled={selfHostedActive}
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor="ws">{t("Gateway WebSocket URL")}</label>
                <input
                  id="ws"
                  value={wsUrl}
                  onChange={(event) => setWsUrl(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="row connection-actions">
                <button
                  type="button"
                  disabled={signingIn || selfHostedActive || !apiUrl.trim()}
                  onClick={signInToSelfHostedIntelligence}
                >
                  {t("Sign in to Intelligence")}
                </button>
                {selfHostedActive && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={cancelSelfHostedSignIn}
                  >
                    {t("Cancel Intelligence sign-in")}
                  </button>
                )}
              </div>
              {selfHostedActive && signingIn && !projects && (
                <p className="footnote" role="status">
                  {t("Finish signing in in the Intelligence browser window…")}
                </p>
              )}
            </details>
            <details>
              <summary>{t("Sign in through your organization")}</summary>
              <p className="footnote">
                {t("Enter your organization’s CCP-Bot address to use its sign-in and access rules.")}
              </p>
              <div className="field">
                <label htmlFor="organization-authority">
                  {t("Organization CCP-Bot URL")}
                </label>
                <input
                  id="organization-authority"
                  value={organizationAuthorityUrl ?? ""}
                  onChange={(event) =>
                    setOrganizationAuthorityUrl(event.target.value)
                  }
                  placeholder={t("https://ccpbot.your-company.com")}
                  spellCheck={false}
                />
              </div>
            </details>
          </fieldset>
        )}

        <SetupProgress steps={steps} />

        {/* Leftover data is a choice, offered above, not a failure to report here. */}
        {displayedFailure && leftoverVolumes.length === 0 && (
          <Failure problem={displayedFailure} />
        )}

        {!running && !returningToInstallation && (
          <details>
            <summary>{t("Installation options")}</summary>
            <button
              type="button"
              className="quiet"
              disabled={busy || signingIn}
              onClick={() => {
                setPreparation(null);
                setSteps([]);
                setStep("install");
              }}
            >
              {t("Change installation")}
            </button>
          </details>
        )}
        <div className="row">
          {!running && (
            <button
              type="button"
              className="quiet"
              disabled={busy || signingIn}
              onClick={() =>
                returningToInstallation
                  ? setRefreshIntelligence(false)
                  : setStep("model")
              }
            >
              {t("Back")}
            </button>
          )}
          {running ? (
            <>
              <button
                type="button"
                /*
                 * The refusal is shown, not swallowed.
                 *
                 * `show_ccpbot` answers with "CCP-Bot is not answering on port 3010 yet, so there
                 * is nothing to show" when the app host process is not up, and this button dropped
                 * it on the floor. Clicking it then did nothing at all, on a screen headed "CCP-Bot
                 * is running", which is the worst of both: a true sentence was available and the
                 * window threw it away. The Ask screen's copy of this call always showed it.
                 */
                onClick={() =>
                  invoke("show_ccpbot").catch((error) =>
                    recoverFromStart(error),
                  )
                }
              >
                {t("Show CCP-Bot")}
              </button>
              <button
                type="button"
                className="quiet"
                onClick={stop}
                disabled={busy}
              >
                {t("Stop CCP-Bot")}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => start()}
              // The model is answered by its own screen now, so what is checked here is that it was
              // answered at all, not that some field on this screen is non-empty.
              //
              // A connection is not a prerequisite on either route. This screen offers one, and a
              // start without one is answered for where it runs: `server_environment` in `local.rs`
              // stands in on this computer, and the server decides for itself what a connection it
              // was not given means. Waiting here would only hide that answer.
              //
              // A run on this computer reports itself through `localBusy`, not `busy`, and it can
              // last minutes: a button left solid over one answers the second click with nothing.
              disabled={
                busy ||
                localBusy ||
                signingIn ||
                !installationReady ||
                !modelCanStart() ||
                root.trim() === ""
              }
            >
              {busy ? t("Working…") : t("Start CCP-Bot")}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

function settleProgress(steps: Progress[], problem?: Problem): Progress[] {
  return steps.map((step) =>
    step.running
      ? {
          ...step,
          running: false,
          ok: !problem,
          detail: problem?.said ?? "Finished.",
        }
      : step,
  );
}

function SetupProgress({ steps }: { steps: Progress[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label={t("Setup progress")} aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow key={step.step} step={step} />
      ))}
    </ol>
  );
}

function SetupProgressRow({ step }: { step: Progress }) {
  const [elapsed, setElapsed] = useState(0);
  const running = step.running ?? false;
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span className="step-status">
        {running ? t("In progress") : step.ok ? "Complete" : "Failed"}
        {running && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {elapsed < 60
              ? `${elapsed}s`
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}{" "}
            {t("elapsed")}
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          ` ${formatDownloadBytes(step.downloadBytes)} downloaded.`}
      </span>
    </li>
  );
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
}

function titleFor(blocker: Blocker): string {
  switch (blocker) {
    case "wsl-absent":
      return t("Windows Subsystem for Linux is not installed");
    case "wsl-one":
      return t("Windows Subsystem for Linux is at version 1");
    case "virtual-machine-platform-disabled":
      return t("Virtual Machine Platform is switched off");
    case "virtualization-disabled":
      return t("Virtualization is off in this machine's firmware");
    case "not-administrator":
      return t("This account cannot install Windows components");
  }
}

function label(step: string): string {
  switch (step) {
    case "engine":
    case "install-engine":
      return t("Container engine");
    case "create-machine":
      return t("Engine machine");
    case "start-machine":
      return t("Starting the machine");
    case "health-gate":
      return t("Engine answering");
    case "deployment":
      return t("Deployment");
    case "env":
      return t("Settings");
    case "ports":
      return t("Ports");
    case "dependencies":
      return t("Dependencies");
    case "recorder":
      return t("Recorder");
    case "images":
      return t("Local software");
    case "installation":
      return t("Installation");
    case "answering":
      return t("Answering");
    case "services":
      return t("Containers");
    case "migrate":
      return t("Database");
    default:
      return step;
  }
}
