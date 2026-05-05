import type { IacChange } from "./types.js";
import { buildBlastRadius } from "./score.js";
import type { BlastRadius } from "./types.js";

// Two input shapes supported:
//   1. kubectl --dry-run=server -o json output of an apply / delete / create.
//      For a single resource: a Kubernetes object with apiVersion, kind, metadata.
//      For multiple: a List with items[].
//   2. A small custom shape we accept too:
//      { mode: "apply"|"delete"|"create", objects: [...] }
//   In either case the caller tells us what mode we're in.

export type KubectlMode = "apply" | "delete" | "create";

type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  // applied: kubectl annotates the live object with its previous state
  // when it computes a server-side dry-run for an apply that changes things.
  // Detecting "actually changes" precisely needs server diff -- for v0 we
  // treat any apply on an existing-named object as an update unless mode=create.
};

function nameOf(o: KubeObject): string {
  const ns = o.metadata?.namespace ?? "default";
  const n = o.metadata?.name ?? "(unnamed)";
  return `${ns}/${n}`;
}

function objectsFromInput(input: unknown): KubeObject[] {
  if (!input) return [];
  if (typeof input === "string") {
    try {
      return objectsFromInput(JSON.parse(input));
    } catch {
      return [];
    }
  }
  if (Array.isArray(input)) {
    return input.flatMap((x) => objectsFromInput(x));
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind === "List" && Array.isArray(obj.items)) {
    return (obj.items as KubeObject[]).slice();
  }
  if (typeof obj.kind === "string") return [obj as KubeObject];
  return [];
}

export function parseKubectlDryRun(
  input: string | object,
  mode: KubectlMode,
): BlastRadius {
  const objects = objectsFromInput(input);
  const changes: IacChange[] = objects.map((o) => {
    const kind: IacChange["kind"] =
      mode === "delete" ? "destroy" : mode === "create" ? "create" : "update";
    return {
      kind,
      resourceType: o.kind ?? "Unknown",
      resourceName: nameOf(o),
      destructive: kind === "destroy",
      source: "kubectl",
    };
  });
  return buildBlastRadius(changes, "kubectl");
}
