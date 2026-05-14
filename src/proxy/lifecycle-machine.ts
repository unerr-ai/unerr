/**
 * Proxy Lifecycle State Machine — XState v5 formalization of the boot sequence.
 *
 * States: idle → detecting → setup|indexing → ready → running → shutdown
 *                                                         ↘ error → shutdown
 *
 * This machine is the source of truth for proxy lifecycle. Every state transition
 * emits events that higher layers (Layer 1 temporal intelligence, Layer 2 UI) can
 * subscribe to without modifying the core boot flow.
 *
 * Design: pure machine definition (no side effects). Side effects are injected
 * via the `actions` map when creating the actor in lifecycle-actor.ts.
 */

import { type ActorRefFrom, assign, setup } from "xstate";

export interface ProxyContext {
  repoPath: string;
  repoId: string | undefined;
  graphLoaded: boolean;
  mcpReady: boolean;
  error: string | undefined;
  bootStartedAt: number;
  stateEnteredAt: number;
}

export type ProxyEvent =
  | { type: "START_DETECT" }
  | { type: "DETECT_COMPLETE"; needsSetup: boolean; repoId?: string }
  | { type: "SETUP_COMPLETE"; repoId: string }
  | { type: "INDEX_START" }
  | { type: "INDEX_COMPLETE" }
  | { type: "GRAPH_LOADED" }
  | { type: "MCP_READY" }
  | { type: "SHUTDOWN" }
  | { type: "ERROR"; message: string };

export type ProxyStateValue =
  | "idle"
  | "detecting"
  | "setup"
  | "indexing"
  | "ready"
  | "running"
  | "error"
  | "shutdown";

export const proxyMachine = setup({
  types: {
    context: {} as ProxyContext,
    events: {} as ProxyEvent,
    input: {} as { repoPath: string },
  },
  actions: {
    recordError: assign({
      error: (_, params: { message: string }) => params.message,
    }),
    markGraphLoaded: assign({ graphLoaded: true }),
    markMcpReady: assign({ mcpReady: true }),
    setRepoId: assign({
      repoId: (_, params: { repoId: string }) => params.repoId,
    }),
    recordStateEntry: assign({ stateEnteredAt: () => Date.now() }),
  },
  guards: {
    needsSetup: (_, params: { needsSetup: boolean }) => params.needsSetup,
    isReady: ({ context }) => context.graphLoaded,
  },
}).createMachine({
  id: "proxy",
  initial: "idle",
  context: ({ input }) => ({
    repoPath: input.repoPath,
    repoId: undefined,
    graphLoaded: false,
    mcpReady: false,
    error: undefined,
    bootStartedAt: Date.now(),
    stateEnteredAt: Date.now(),
  }),
  states: {
    idle: {
      on: {
        START_DETECT: {
          target: "detecting",
          actions: [{ type: "recordStateEntry" }],
        },
      },
    },

    detecting: {
      on: {
        DETECT_COMPLETE: [
          {
            guard: {
              type: "needsSetup",
              params: ({ event }) => ({ needsSetup: event.needsSetup }),
            },
            target: "setup",
            actions: [{ type: "recordStateEntry" }],
          },
          {
            target: "indexing",
            actions: [
              { type: "recordStateEntry" },
              {
                type: "setRepoId",
                params: ({ event }) => ({ repoId: event.repoId ?? "" }),
              },
            ],
          },
        ],
        ERROR: {
          target: "error",
          actions: [
            {
              type: "recordError",
              params: ({ event }) => ({ message: event.message }),
            },
            { type: "recordStateEntry" },
          ],
        },
      },
    },

    setup: {
      on: {
        SETUP_COMPLETE: {
          target: "indexing",
          actions: [
            {
              type: "setRepoId",
              params: ({ event }) => ({ repoId: event.repoId }),
            },
            { type: "recordStateEntry" },
          ],
        },
        ERROR: {
          target: "error",
          actions: [
            {
              type: "recordError",
              params: ({ event }) => ({ message: event.message }),
            },
            { type: "recordStateEntry" },
          ],
        },
        SHUTDOWN: { target: "shutdown" },
      },
    },

    indexing: {
      on: {
        GRAPH_LOADED: {
          actions: [{ type: "markGraphLoaded" }],
        },
        INDEX_COMPLETE: {
          target: "ready",
          actions: [{ type: "recordStateEntry" }],
        },
        ERROR: {
          target: "error",
          actions: [
            {
              type: "recordError",
              params: ({ event }) => ({ message: event.message }),
            },
            { type: "recordStateEntry" },
          ],
        },
        SHUTDOWN: { target: "shutdown" },
      },
    },

    ready: {
      on: {
        MCP_READY: {
          target: "running",
          actions: [{ type: "markMcpReady" }, { type: "recordStateEntry" }],
        },
        ERROR: {
          target: "error",
          actions: [
            {
              type: "recordError",
              params: ({ event }) => ({ message: event.message }),
            },
            { type: "recordStateEntry" },
          ],
        },
        SHUTDOWN: { target: "shutdown" },
      },
    },

    running: {
      on: {
        ERROR: {
          target: "error",
          actions: [
            {
              type: "recordError",
              params: ({ event }) => ({ message: event.message }),
            },
            { type: "recordStateEntry" },
          ],
        },
        SHUTDOWN: {
          target: "shutdown",
          actions: [{ type: "recordStateEntry" }],
        },
      },
    },

    error: {
      on: {
        SHUTDOWN: {
          target: "shutdown",
          actions: [{ type: "recordStateEntry" }],
        },
      },
    },

    shutdown: {
      type: "final",
    },
  },
});

export type ProxyMachineActor = ActorRefFrom<typeof proxyMachine>;
