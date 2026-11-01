/*
 * The DS-Bot contract harness. NOT a product surface: no navigation entry points here, nothing
 * links to it, and it is not the UI the port is going to ship. It exists so Phase 1 can be seen
 * working against this deployment's own data — the checks are written down in
 * `docs/ds-bot-phase1.md`. Delete it when the port reaches parity and a real screen replaces it.
 *
 * What it does: loads DS-Bot's own client bundle verbatim (`app/vendor/ds-bot/client.js`, copied
 * byte for byte from the upstream repository), gives it the six services its `inject` list names
 * — `sessions`, `uiWorkspace`, `uiConversation`, `slots`, `theme`, `layout` — and calls `apply`.
 * Everything else the client reaches for through `ctx.get(...)` is deliberately absent, so the
 * client takes its own "no such service" paths instead of being handed a convincing fake: the
 * parts of DS-Bot that need the DSH runtime show up here as missing, which is the point of the
 * exercise. Whatever the client registers into a slot is rendered below inside its own error
 * boundary, so one component that needs a service we cannot give it does not take the others down.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import clientUrl from "../../../vendor/ds-bot/client.js?url";

type Source<T> = {
  getSnapshot: () => T;
  set: (next: T | ((previous: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
};

function createSource<T>(initial: T): Source<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    set: (next) => {
      value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type SlotEntry = {
  name?: string;
  component?: unknown;
  /** A host directive, not a prop: the shell calls it and hands the result to the component. */
  inject?: () => Record<string, unknown>;
  options?: Record<string, unknown>;
};

type BotState = {
  revision?: number;
  workspaceId?: string;
  bots?: { id: string; name?: string; sessionId?: string }[];
  prefs?: Record<string, unknown>;
  readOnly?: boolean;
};

type Registration = {
  id: string;
  module: { apply: (ctx: unknown) => void; inject?: string[] };
};

type Loader = {
  load: (registration: { id: string; factory: unknown }) => void;
  pendingQueue?: unknown[];
  mode?: string;
};

/** The bundle is a classic script that calls `window.__ModuleLoader__.load(...)` as it parses, so
 * the loader has to be in place before the tag is appended — including the queueing shape the
 * upstream test uses for a script that arrives before its host (`styles.test.js:81`). */
function installLoader(): Loader {
  const host = window as unknown as { __ModuleLoader__?: Loader };
  if (host.__ModuleLoader__) return host.__ModuleLoader__;
  const loader: Loader = {
    mode: "queue",
    pendingQueue: [],
    load(registration) {
      this.pendingQueue?.push(registration);
    },
  };
  host.__ModuleLoader__ = loader;
  return loader;
}

function MarkdownText({ text }: { text?: string }) {
  return <span>{text ?? ""}</span>;
}

/**
 * What DS-Bot's own UI shell does for every store it hands its components
 * (`app/ui/src/team.js:248`): a selector hook over a store. `getSnapshot` has to keep returning the
 * same value for the same store contents, or React re-renders in a loop, so the selection is cached
 * against the snapshot it came from.
 */
function useSelect(store: unknown, selector: (value: never) => unknown): unknown {
  const { getSnapshot, subscribe } = store as Source<unknown>;
  const cache = useRef<{ value: unknown; selected: unknown } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    const value = getSnapshot();
    if (!cache.current || cache.current.value !== value) {
      cache.current = { value, selected: selector(value as never) };
    }
    return cache.current.selected;
  });
}

/**
 * DS-Bot's components ask for `useRoster`/`useUi`/… and call them during their own render, so the
 * harness has to hand over something shaped like a hook. This builds one: the name starts with
 * `use` because that is what the components call it, and it is the only way to give a component a
 * hook the host owns without wrapping every component in a provider.
 */
function makeSelectHook(store: unknown) {
  return function useSelected(selector: (value: never) => unknown): unknown {
    return useSelect(store, selector);
  };
}

/** The Session-list spelling of the same idea: the selector reads the row the id names. */
function makeRetainInfoHook(store: unknown) {
  return function useRetainedInfo(id: string, selector: (value: never) => unknown): unknown {
    return useSelect(
      store,
      ((list: { byId: Record<string, unknown> }) => selector(list.byId[id] as never)) as (value: never) => unknown,
    );
  };
}

/** The three platform modules the bundle's factory asks for (`client-bundle.test.js:14-40`). */
function requireModule(name: string): unknown {
  if (name === "react") return React;
  if (name === "react-dom") return { createPortal };
  return { MarkdownText };
}

class SlotBoundary extends Component<{ label: string; children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded border border-destructive/40 p-2 text-xs">
          <div className="font-medium">{this.props.label}</div>
          <div className="text-muted-foreground">{this.state.error}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

function HarnessPage() {
  const [state, setState] = useState<BotState | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [effects, setEffects] = useState<string[]>([]);
  const [entries, setEntries] = useState<SlotEntry[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const started = useRef(false);
  const registered = useRef<SlotEntry[]>([]);
  const listeners = useRef(new Set<() => void>());
  const sessionSource = useRef<Source<{ byId: Record<string, unknown>; ids: string[]; agentOf: Record<string, string> }>>(undefined);
  if (sessionSource.current === undefined) {
    sessionSource.current = createSource<{ byId: Record<string, unknown>; ids: string[]; agentOf: Record<string, string> }>({
      byId: {},
      ids: [],
      agentOf: {},
    });
  }
  const sessionList = sessionSource.current;

  const call = useCallback(async (endpoint: string, payload?: unknown) => {
    const response = await fetch("/api/bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
    });
    return (await response.json()) as unknown;
  }, []);

  /*
   * The bundle loads once per page: the guard is a ref, not a dependency, so this runs on the first
   * render and never again. `sessionList` is in the list because the client's `ctx.sessions` holds
   * it — it is a stable ref value that never changes identity.
   */
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const loader = installLoader();
      const element = document.createElement("script");
      element.src = clientUrl;
      element.async = false;
      document.head.appendChild(element);

      await new Promise<void>((resolve, reject) => {
        element.addEventListener("load", () => resolve());
        element.addEventListener("error", () => reject(new Error(`the bundle at ${clientUrl} did not load`)));
      });

      const queued = loader.pendingQueue ?? [];
      const registration = queued[queued.length - 1] as
        | { id: string; factory: (require: (name: string) => unknown) => Registration["module"] }
        | undefined;
      if (!registration) {
        setFailure("the bundle loaded but registered nothing with window.__ModuleLoader__");
        return;
      }

      /*
       * `slots.inject(name, fn)` is how DS-Bot installs its interface: the shell calls back so the
       * plugin can register into that slot (`src/client/index.js:748-751`, `:817-860`), and what it
       * registers is an entry plus the component to draw. Both halves are kept, because a slot
       * whose component was dropped renders nothing and would look like the port had failed.
       */
      const slots = {
        register: (entry: SlotEntry, component?: unknown) => {
          registered.current = [...registered.current, { ...entry, component }];
          setEntries(registered.current);
          return disposable();
        },
        inject: (_name: string, fn: () => unknown) => {
          fn();
          return disposable();
        },
        subscribe: (_name: string, refresh: () => void) => {
          listeners.current.add(refresh);
          return () => listeners.current.delete(refresh);
        },
        entries: (name: string) => registered.current.filter((entry) => entry.name === name),
        spec: (name: string) => ({ name }),
      };
      /** DSH hands back a disposable that is also callable; the client uses both spellings. */
      const disposable = () => {
        const off = () => {};
        return Object.assign(off, { dispose: off });
      };
      const chatSnapshot = () => undefined;
      const conversation = {
        binding: () => ({
          target: () => ({ getSnapshot: chatSnapshot, subscribe: () => () => {} }),
          openTurn: { getSnapshot: chatSnapshot, subscribe: () => () => {} },
        }),
      };
      const ctx = {
        /* Every declared service, the smallest honest shape that lets `apply` run. Nothing here
         * invents data: an empty session list is what this deployment has. */
        effect: (fn: () => undefined | (() => void), label: string) => {
          setEffects((previous) => [...previous, label]);
          const dispose = fn();
          return typeof dispose === "function" ? Object.assign(dispose, { dispose }) : disposable();
        },
        get: (name: string) =>
          name === "inputTriggers" ? { registerSource: () => () => {}, sessionOf: () => undefined } : undefined,
        inject: (_names: string[], fn: (scope: Record<string, unknown>) => void) => {
          fn(ctx);
          return disposable();
        },
        sessions: { list: sessionList, binding: () => undefined, refresh: async () => {}, refreshProjections: async () => {} },
        uiWorkspace: {},
        uiConversation: conversation,
        slots,
        theme: { overrideTokens: () => () => {} },
        layout: { selectPanel: () => {}, toggleSidebar: () => {} },
      };

      try {
        const module = registration.factory(requireModule);
        module.apply(ctx);
        setBooted(true);
      } catch (error) {
        setFailure(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
    })();
  }, [sessionList]);

  const readState = useCallback(async () => {
    const result = (await call("state")) as { ok: boolean; value?: BotState; error?: { message?: string } };
    setAnswer(JSON.stringify(result, null, 2));
    if (result.ok && result.value) {
      setState(result.value);
      /*
       * The sidebar walks `ctx.sessions.list.getSnapshot().byId` for the Sessions it shows, so the
       * snapshot is filled with the Sessions this deployment's own `state` named — the same ids the
       * `chat` arm answers for. Handing it `{}` would be a shell that knows about Bots and no
       * conversations, which is not what the port answers.
       */
      sessionList.set({
        ...sessionList.getSnapshot(),
        byId: Object.fromEntries((result.value.bots ?? []).map((bot) => [bot.sessionId, { id: bot.sessionId, retainedBy: { mainView: 1 } }])),
        ids: (result.value.bots ?? []).flatMap((bot) => (bot.sessionId ? [bot.sessionId] : [])),
        agentOf: Object.fromEntries(
          (result.value.bots ?? []).flatMap((bot) => (bot.sessionId ? [[bot.sessionId, bot.id]] : [])),
        ),
      });
    }
  }, [call, sessionList]);

  useEffect(() => {
    void readState();
  }, [readState]);

  /*
   * A slot entry is `{name, …host directives, inject?, component}` (`src/client/index.js:748-751`).
   * `inject` is a host directive, not a component prop: the shell calls it and hands the result to
   * the component as props — which is where ds-bot's `useRoster`/`useUi`/`useSurface` and its
   * `actions` come from (`index.js:630`). Rendering a component without them is a blank pane that
   * says nothing about the contract, so they are called once per registration.
   */
  const panes = useMemo(
    () =>
      entries
        .filter((entry) => typeof entry.component !== "undefined")
        .map((entry) => {
          const injected = typeof entry.inject === "function" ? entry.inject() : {};
          const hooks = (injected as { hooks?: Record<string, unknown> }).hooks ?? {};
          /*
           * `face()` hands back stores (`{roster, ui, surface, …}`, `index.js:630`) and its
           * components ask for hooks (`useRoster`, `useUi`, …) — the conversion DS-Bot's own UI
           * shell spells out as `use = source => selector => useSelect(source, selector)`
           * (`app/ui/src/team.js:248-267`). Without it every component throws on its first hook and
           * the harness shows error text where the team surface should be.
           */
          const readable = Object.fromEntries(
            Object.entries(hooks).map(([key, store]) => [
              `use${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`,
              makeSelectHook(store),
            ]),
          );
          return {
            label: entry.name ?? "slot",
            Component: entry.component as ComponentType<Record<string, unknown>>,
            props: {
              ...injected,
              ...readable,
              /*
               * `face()` covers the stores DS-Bot owns; the Session list is the host's, handed to the
               * client as `ctx.sessions` (`index.js:631-634` reads it) and to its components as these
               * hooks. Empty Sessions would make the sidebar look right and show nothing.
               */
              useSessions: makeSelectHook(sessionList),
              useSessionStatus: () => undefined,
              useSessionRetainInfo: makeRetainInfoHook(sessionList),
            } as Record<string, unknown>,
          };
        }),
    [entries, sessionList],
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6 text-sm">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">DS-Bot contract harness</h1>
        <p className="text-muted-foreground">
          A development surface, not a shipped screen. It loads DS-Bot&apos;s own client bundle against{" "}
          <code>/api/bot</code> and renders whatever that client registers.
        </p>
      </header>

      <section className="rounded border p-3">
        <div className="font-medium">The client bundle</div>
        <div>loaded: {String(booted)}</div>
        {failure ? <div className="text-destructive">{failure}</div> : null}
        <div>effects it installed: {effects.length ? effects.join(" · ") : "(none)"}</div>
        <div>slot registrations: {entries.length}</div>
      </section>

      <section className="space-y-2 rounded border p-3">
        <div className="flex items-center gap-2">
          <div className="font-medium">What this deployment answered for `state`</div>
          <button type="button" className="rounded border px-2" onClick={() => void readState()}>
            read again
          </button>
        </div>
        {state ? (
          <div>
            revision {String(state.revision)} · workspace {String(state.workspaceId)} · readOnly{" "}
            {String(state.readOnly)} · mainBotIds {JSON.stringify(state.bots?.map((bot) => bot.id) ?? [])}
          </div>
        ) : null}
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{answer}</pre>
      </section>

      {panes.map(({ label, Component, props }, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: slot names repeat (three `shell.overlay` entries), so the position is the only thing telling the panes apart.
        <SlotBoundary key={`${label}-${index}`} label={label}>
          <div className="rounded border p-3">
            <div className="font-medium">{label}</div>
            <Component {...props} />
          </div>
        </SlotBoundary>
      ))}
    </div>
  );
}

export const Route = createFileRoute("/_authed/ds-bot-harness")({
  component: HarnessPage,
});