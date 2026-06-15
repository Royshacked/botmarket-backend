/**
 * Execution bus — the single, broker-agnostic channel for normalized trade
 * execution events.
 *
 * Every broker adapter that streams fills/closes translates its native push
 * (cTrader ProtoOA ExecutionEvent, IBKR fill, …) into a BrokerExecution and emits
 * it here. Consumers — the idea-status reconciler today, an SSE bridge to the
 * browser tomorrow — subscribe ONCE and never care which broker produced the
 * event. This keeps the multi-broker design unified (see project memory:
 * "one backend→frontend real-time channel").
 *
 *   import { executionBus } from '../services/executionBus.js'
 *   executionBus.on('execution', (exec) => { ... })   // BrokerExecution
 *   executionBus.emit('execution', exec)              // from an adapter
 *
 * @typedef {import('../api/broker/adapters/broker.interface.js').BrokerExecution} BrokerExecution
 */

import { EventEmitter } from 'node:events'

class ExecutionBus extends EventEmitter {}

// Process-wide singleton. Many feeds publish; raise the listener cap so adding
// brokers/consumers never trips the default-10 warning.
export const executionBus = new ExecutionBus()
executionBus.setMaxListeners(0)
