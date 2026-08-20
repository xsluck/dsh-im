function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Watches Harness sessions that are bound to an IM conversation even when no
 * IM-driven ask() is currently in flight. Web-originated ask_user_question and
 * approval interactions are delivered to the most recently active IM route.
 */
export class InteractionForwarder {
  #harness;
  #logger;
  #parentSignal;
  #watchers = new Map();
  #defaultRoutes = new Map();
  #defaultWatcher = null;
  #handler;
  #onResolved;
  #canWatch = false;
  #canWatchAll = false;

  constructor({
    harness,
    signal,
    logger = console,
    onInteraction,
    onResolved,
  }) {
    if (typeof onInteraction !== 'function') {
      throw new TypeError('InteractionForwarder requires an onInteraction callback');
    }
    this.#harness = harness;
    this.#logger = logger;
    this.#parentSignal = signal ?? null;
    this.#handler = onInteraction;
    this.#onResolved = typeof onResolved === 'function' ? onResolved : null;
    this.#canWatch = Boolean(harness && typeof harness.watchInteractions === 'function');
    this.#canWatchAll = Boolean(harness && typeof harness.watchAllInteractions === 'function');
  }

  setRoute(route) {
    const sessionId = nonEmptyString(route?.sessionId);
    const key = nonEmptyString(route?.key);
    if (!sessionId || !key || typeof route?.send !== 'function') {
      throw new TypeError('route requires sessionId, key, and a send function');
    }
    if (!this.#canWatch) return;
    this.#removeKey(key, sessionId);

    let watcher = this.#watchers.get(sessionId);
    if (!watcher) {
      const controller = new AbortController();
      const signal = this.#parentSignal
        ? AbortSignal.any([this.#parentSignal, controller.signal])
        : controller.signal;
      watcher = {
        controller,
        promise: null,
        routes: new Map(),
      };
      this.#watchers.set(sessionId, watcher);
      watcher.promise = this.#harness.watchInteractions(sessionId, {
        signal,
        onInteraction: (interaction) => this.#onInteraction(sessionId, interaction),
        onResolved: (resolution) => this.#onResolved?.(resolution),
      }).catch((error) => {
        if (!controller.signal.aborted && this.#parentSignal?.aborted !== true) {
          this.#logger.warn?.(
            `[dsh-im] interaction forwarder for session ${sessionId} stopped:`,
            error,
          );
        }
      });
    }
    watcher.routes.set(key, {
      sessionId,
      key,
      updatedAt: Number.isFinite(route.updatedAt) ? route.updatedAt : Date.now(),
      actor: route.actor,
      contextToken: route.contextToken,
      runId: route.runId,
      chatId: route.chatId,
      requiresMention: route.requiresMention === true,
      send: route.send,
      ...route,
    });
  }

  setDefaultRoute(route) {
    const key = nonEmptyString(route?.key);
    if (!key || typeof route?.send !== 'function') {
      throw new TypeError('default route requires key and a send function');
    }
    if (!this.#canWatchAll) return;
    this.#defaultRoutes.set(key, {
      sessionId: '*',
      key,
      updatedAt: Number.isFinite(route.updatedAt) ? route.updatedAt : Date.now(),
      actor: route.actor,
      contextToken: route.contextToken,
      runId: route.runId,
      chatId: route.chatId,
      requiresMention: route.requiresMention === true,
      send: route.send,
      ...route,
    });
    if (!this.#defaultWatcher) {
      const controller = new AbortController();
      const signal = this.#parentSignal
        ? AbortSignal.any([this.#parentSignal, controller.signal])
        : controller.signal;
      this.#defaultWatcher = { controller, promise: null };
      this.#defaultWatcher.promise = this.#harness.watchAllInteractions({
        signal,
        onInteraction: (interaction) => this.#onInteraction(interaction.sessionId, interaction, { allowDefault: true }),
        onResolved: (resolution) => this.#onResolved?.(resolution),
      }).catch((error) => {
        if (!controller.signal.aborted && this.#parentSignal?.aborted !== true) {
          this.#logger.warn?.(
            '[dsh-im] default interaction forwarder stopped:',
            error,
          );
        }
      });
    }
  }

  removeRoute(key) {
    if (typeof key !== 'string' || !key) return;
    this.#defaultRoutes.delete(key);
    if (this.#defaultRoutes.size === 0) this.#stopDefaultWatcher();
    if (!this.#canWatch) return;
    for (const [sessionId, watcher] of this.#watchers) {
      if (watcher.routes.has(key)) {
        watcher.routes.delete(key);
        if (watcher.routes.size === 0) this.#stopWatcher(sessionId);
      }
    }
  }

  stop() {
    this.#stopDefaultWatcher();
    if (!this.#canWatch) return;
    for (const sessionId of [...this.#watchers.keys()]) {
      this.#stopWatcher(sessionId);
    }
  }

  #stopDefaultWatcher() {
    if (!this.#defaultWatcher) return;
    this.#defaultWatcher.controller.abort();
    this.#defaultWatcher = null;
  }

  #removeKey(key, keepSessionId) {
    for (const [sessionId, watcher] of this.#watchers) {
      if (sessionId === keepSessionId) continue;
      if (watcher.routes.has(key)) {
        watcher.routes.delete(key);
        if (watcher.routes.size === 0) this.#stopWatcher(sessionId);
      }
    }
  }

  #stopWatcher(sessionId) {
    const watcher = this.#watchers.get(sessionId);
    if (!watcher) return;
    this.#watchers.delete(sessionId);
    watcher.controller.abort();
  }

  #chooseRoute(sessionId) {
    const watcher = this.#watchers.get(sessionId);
    if (!watcher) return null;
    let best = null;
    for (const route of watcher.routes.values()) {
      if (!best || route.updatedAt > best.updatedAt) best = route;
    }
    return best;
  }

  #chooseDefaultRoute() {
    let best = null;
    for (const route of this.#defaultRoutes.values()) {
      if (!best || route.updatedAt > best.updatedAt) best = route;
    }
    return best;
  }

  #onInteraction(sessionId, interaction, { allowDefault = false } = {}) {
    const exact = this.#chooseRoute(sessionId);
    if (exact) {
      if (!allowDefault) return this.#dispatch(interaction, exact);
      return;
    }
    if (!allowDefault) return;
    const fallback = this.#chooseDefaultRoute();
    if (!fallback) return;
    return this.#dispatch(interaction, fallback);
  }

  #dispatch(interaction, route) {
    try {
      return Promise.resolve(this.#handler(interaction, route)).catch((error) => {
        this.#logger.error?.('[dsh-im] interaction forwarder handler failed:', error);
      });
    } catch (error) {
      this.#logger.error?.('[dsh-im] interaction forwarder handler threw:', error);
      return undefined;
    }
  }
}
