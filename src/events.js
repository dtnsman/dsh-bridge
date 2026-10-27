// src/events.js
'use strict';

class EventBridge {
  constructor({ mux, rpc, registry }) {
    this.mux = mux;
    this.rpc = rpc;
    this.registry = registry;

    this.clientId = null;
    this.listeners = new Set();
    this._stream = null;
    this._readyCount = 0;
  }

  async start() {
    this._stream = this.mux.open('$events', {}, {
      onItem: (v) => this._onItem(v),
      onError: (e) => {
        console.error('[events] stream error:', e);
      },
      onEnd: () => {
        console.log('[events] stream ended');
      },
    });
  }

  _onItem(v) {
    if (v?.type === 'ready') {
      this.clientId = v.clientId;
      this._readyCount++;
      console.log(`[events] ready #${this._readyCount} clientId=${this.clientId}`);
      return;
    }

    if (v?.type === 'waterfall') {
      this._handleWaterfall(v);
      return;
    }

    if (v?.event) {
      this.registry?.applyEvent(v.event, v.args);
      for (const fn of this.listeners) {
        try { fn(v.event, v.args); } catch (e) { console.warn(e.message); }
      }
    }
  }

  async _handleWaterfall(v) {
    try {
      await this.rpc.call('$events', 'result', {
        clientId: this.clientId,
        eventId: v.eventId,
        outcome: { kind: 'result', value: 'allowed-once' },
      });
      console.log(`[events] waterfall auto-allowed: ${v.event} eventId=${v.eventId}`);
    } catch (e) {
      console.error('[events] waterfall reply failed:', e.code || e.message);
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { EventBridge };