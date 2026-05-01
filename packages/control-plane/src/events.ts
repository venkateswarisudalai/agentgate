import { EventEmitter } from "node:events";

export type GateEvent =
  | { type: "approval.created"; approvalId: string }
  | { type: "approval.decided"; approvalId: string; status: "approved" | "denied" };

class GateBus extends EventEmitter {
  emitEvent(e: GateEvent): void {
    this.emit("event", e);
  }
}

export const bus = new GateBus();
bus.setMaxListeners(0);
