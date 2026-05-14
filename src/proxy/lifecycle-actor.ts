/**
 * Proxy Lifecycle Actor — wraps XState machine with a convenient imperative API.
 *
 * proxy.ts creates one LifecycleActor per boot. The actor:
 *   - Receives events from each boot step
 *   - Emits state transitions for subscribers (startup renderer, telemetry)
 *   - Provides .waitFor(state) for async coordination
 *   - Tracks timing for each phase (detecting, indexing, etc.)
 */

import { type Subscription, createActor, waitFor } from "xstate";
import {
  type ProxyContext,
  type ProxyEvent,
  type ProxyMachineActor,
  type ProxyStateValue,
  proxyMachine,
} from "./lifecycle-machine.js";

export interface LifecycleActor {
  send: (event: ProxyEvent) => void;
  getState: () => ProxyStateValue;
  getContext: () => ProxyContext;
  getSnapshot: () => { value: ProxyStateValue; context: ProxyContext };
  waitForState: (state: ProxyStateValue, timeoutMs?: number) => Promise<void>;
  subscribe: (
    callback: (state: ProxyStateValue, context: ProxyContext) => void,
  ) => Subscription;
  stop: () => void;
}

export function createLifecycleActor(repoPath: string): LifecycleActor {
  const actor = createActor(proxyMachine, {
    input: { repoPath },
  });

  actor.start();

  const send = (event: ProxyEvent): void => {
    actor.send(event);
  };

  const getState = (): ProxyStateValue => {
    return actor.getSnapshot().value as ProxyStateValue;
  };

  const getContext = (): ProxyContext => {
    return actor.getSnapshot().context;
  };

  const getSnapshot = () => ({
    value: getState(),
    context: getContext(),
  });

  const waitForState = async (
    state: ProxyStateValue,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const snap = actor.getSnapshot();
    if (snap.value === state) return;
    if (snap.status === "done") return;

    await waitFor(
      actor,
      (snapshot) => snapshot.value === state || snapshot.status === "done",
      { timeout: timeoutMs },
    );
  };

  const subscribe = (
    callback: (state: ProxyStateValue, context: ProxyContext) => void,
  ): Subscription => {
    return actor.subscribe((snapshot) => {
      callback(snapshot.value as ProxyStateValue, snapshot.context);
    });
  };

  const stop = (): void => {
    actor.stop();
  };

  return {
    send,
    getState,
    getContext,
    getSnapshot,
    waitForState,
    subscribe,
    stop,
  };
}

export type { ProxyMachineActor };
