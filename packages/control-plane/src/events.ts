import { EventEmitter } from "node:events";

export type GateEvent =
  | { type: "approval.created"; approvalId: string }
  | { type: "approval.decided"; approvalId: string; status: "approved" | "denied" }
  | { type: "session.started"; sessionId: string; agent: string }
  | { type: "session.ended"; sessionId: string; agent: string }
  | { type: "agent.quarantined"; agent: string; until: string }
  | { type: "agent.released"; agent: string }
  | { type: "shadow.recorded"; agent: string; action: string };

class GateBus extends EventEmitter {
  emitEvent(e: GateEvent): void {
    this.emit("event", e);
  }
}

export const bus = new GateBus();
bus.setMaxListeners(0);
