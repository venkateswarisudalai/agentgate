import type { ChangeKind, IacChange } from "./types.js";
import { buildBlastRadius } from "./score.js";
import type { BlastRadius } from "./types.js";

// Schema reference: terraform show -json plan output
//   https://developer.hashicorp.com/terraform/internals/json-format
// We only consume `resource_changes`. Each entry has:
//   { address, type, name, change: { actions: string[], before, after } }
// Possible action arrays:
//   ["no-op"], ["create"], ["read"], ["update"], ["delete"],
//   ["delete","create"]   (replace, destroy then create)
//   ["create","delete"]   (replace, create then destroy)

type TfActions = string[];

type TfChange = {
  address: string;
  type: string;
  name: string;
  change: {
    actions: TfActions;
    before?: unknown;
    after?: unknown;
  };
};

type TfPlan = {
  resource_changes?: TfChange[];
};

function actionsToKind(actions: TfActions): ChangeKind {
  // Order-independent for replace detection
  const set = new Set(actions);
  if (set.has("delete") && set.has("create")) return "replace";
  if (set.has("delete")) return "destroy";
  if (set.has("create")) return "create";
  if (set.has("update")) return "update";
  if (set.has("read")) return "noop";
  return "noop";
}

function changedAttributes(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    return [];
  }
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const out = new Set<string>();
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.add(k);
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) out.add(k);
  }
  return Array.from(out);
}

export function parseTerraformPlan(planJson: string | object): BlastRadius {
  const plan: TfPlan =
    typeof planJson === "string" ? (JSON.parse(planJson) as TfPlan) : (planJson as TfPlan);
  const rcs = plan.resource_changes ?? [];

  const changes: IacChange[] = rcs.map((rc) => {
    const kind = actionsToKind(rc.change.actions);
    const attrs =
      kind === "update" ? changedAttributes(rc.change.before, rc.change.after) : [];
    return {
      kind,
      resourceType: rc.type,
      resourceName: rc.address ?? `${rc.type}.${rc.name}`,
      changedAttributes: attrs.length ? attrs : undefined,
      destructive: kind === "destroy" || kind === "replace",
      source: "terraform",
    };
  });

  return buildBlastRadius(changes, "terraform");
}
