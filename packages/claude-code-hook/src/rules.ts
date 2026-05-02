export type Category =
  | "filesystem"
  | "git"
  | "infra"
  | "cloud"
  | "db"
  | "ml"
  | "data"
  | "secrets"
  | "iam"
  | "ci-cd"
  | "gitops"
  | "system"
  | "supply-chain"
  | "network"
  | "container";

export type Severity = "high" | "medium" | "low";
export type Recoverable = "no" | "partial" | "yes" | "unknown";

export type Impact = {
  headline: string;
  consequences: string[];
  recoverable: Recoverable;
  targets?: Record<string, string>;
};

export type RuleMatch = {
  ruleId: string;
  category: Category;
  severity: Severity;
  description: string;
  impact: Impact;
};

export type ToolPayload = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

type DescribeFn = (cmd: string, m: RegExpExecArray) => Impact;
type DescribePathFn = (path: string, m: RegExpExecArray) => Impact;

type BashRule = {
  id: string;
  category: Category;
  description: string;
  severity: Severity;
  pattern: RegExp;
  describe: DescribeFn;
};

type PathRule = {
  id: string;
  category: Category;
  description: string;
  severity: Severity;
  pattern: RegExp;
  describe: DescribePathFn;
};

// ---------- helpers ----------

function arg(cmd: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(`(?:^|\\s)${name}(?:[=\\s]+)("[^"]+"|'[^']+'|\\S+)`);
    const m = cmd.match(re);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

function firstNonFlag(cmd: string, after: RegExp): string | undefined {
  const idx = cmd.search(after);
  if (idx < 0) return undefined;
  const tail = cmd.slice(idx).split(/\s+/).slice(1);
  for (const tok of tail) {
    if (!tok.startsWith("-")) return tok;
  }
  return undefined;
}

function genericImpact(headline: string, consequences: string[], recoverable: Recoverable = "no"): Impact {
  return { headline, consequences, recoverable };
}

// ---------- BASH RULES ----------

const BASH_RULES: BashRule[] = [
  // ===== filesystem =====
  { id: "rm-rf", category: "filesystem", severity: "high",
    description: "Recursive force delete",
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\b/,
    describe: (cmd) => {
      const target = firstNonFlag(cmd, /\brm\s+/) ?? "(target unparsed)";
      return {
        headline: `Recursively delete '${target}' and everything under it.`,
        consequences: [
          "All files and subdirectories under the target are removed",
          "Files are not moved to a trash; they are unlinked from the filesystem",
          "Recovery requires a backup or filesystem-level snapshot — undelete tools rarely work on modern SSDs",
        ],
        recoverable: "no",
        targets: { path: target },
      };
    } },
  { id: "rm-root", category: "filesystem", severity: "high",
    description: "Delete near filesystem root",
    pattern: /\brm\s+.*\s+(\/|~|\$HOME|\.\.|\*)\s*$/,
    describe: () => genericImpact(
      "Delete files at the filesystem root, $HOME, '..' or with a bare wildcard.",
      [
        "Targets a path that resolves to the user's entire home directory or the system root",
        "On many systems this either bricks the install or wipes all user data",
        "Almost never the intended action",
      ],
    ) },
  { id: "fork-bomb", category: "system", severity: "high",
    description: "Fork bomb",
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
    describe: () => genericImpact(
      "Fork bomb — exhausts process table until the machine becomes unresponsive.",
      [
        "Recursive process spawning that grows exponentially",
        "Typically requires a hard reboot to recover",
        "No legitimate use case",
      ],
    ) },
  { id: "dd-device", category: "system", severity: "high",
    description: "Raw disk write via dd",
    pattern: /\bdd\s+.*of=\/dev\//,
    describe: (cmd) => {
      const of = cmd.match(/of=(\S+)/)?.[1] ?? "(unknown device)";
      return genericImpact(
        `Write raw bytes directly to ${of} — destroys any data on that device.`,
        [
          "Bypasses the filesystem and writes directly to the block device",
          "Existing partitions, filesystems, and data on the device are destroyed",
          "If the device is the boot disk, the system will not survive a reboot",
        ],
      );
    } },
  { id: "mkfs", category: "system", severity: "high",
    description: "Filesystem format",
    pattern: /\bmkfs(\.\w+)?\b/,
    describe: () => genericImpact(
      "Format a block device — creates a fresh empty filesystem on the target.",
      [
        "All existing data on the formatted device is unrecoverable",
        "Mount points referencing the device may break",
      ],
    ) },
  { id: "find-delete", category: "filesystem", severity: "high",
    description: "find ... -delete (silent recursive delete)",
    pattern: /\bfind\s+.*\s+-delete\b/,
    describe: () => genericImpact(
      "Walk a directory and delete every file matching the find expression.",
      [
        "No prompt; deletes everything that matches the find filters",
        "Easy to widen the match by accident (e.g. '-name *' deletes everything)",
        "Silent — no output unless an error",
      ],
    ) },
  { id: "find-xargs-rm", category: "filesystem", severity: "medium",
    description: "find ... | xargs rm",
    pattern: /\bfind\s+.*\|\s*xargs\s+rm\b/,
    describe: () => genericImpact(
      "Pipe find results into xargs rm — deletes every matched file.",
      [
        "Filename quoting bugs can delete the wrong files when names contain spaces or newlines",
        "Use 'find -delete' or 'xargs -0' with 'find -print0' to be safe",
      ],
    ) },

  // ===== git =====
  { id: "git-force-push", category: "git", severity: "high",
    description: "Force push to git remote",
    pattern: /\bgit\s+push\s+(.*\s+)?(-f\b|--force\b|--force-with-lease\b)/,
    describe: (cmd) => {
      const remote = cmd.match(/git\s+push\s+(?:.*\s+)?(\S+)\s+(\S+)/)?.[1] ?? "origin";
      const branch = cmd.match(/git\s+push\s+(?:.*\s+)?\S+\s+(\S+)/)?.[1] ?? "(branch unparsed)";
      return {
        headline: `Overwrite the '${branch}' branch on remote '${remote}', discarding remote-only commits.`,
        consequences: [
          `Any commits on ${remote}/${branch} not present locally will be lost`,
          "Anyone else who pulled that branch will need to reset or re-clone",
          "Recovery requires a copy of the lost SHAs from another clone or 30-day reflog",
        ],
        recoverable: "partial",
        targets: { remote, branch },
      };
    } },
  { id: "git-push-main", category: "git", severity: "medium",
    description: "Push directly to main/master/prod branch",
    pattern: /\bgit\s+push\s+.*\b(main|master|prod|production|release)\b/,
    describe: (cmd) => {
      const branch = cmd.match(/\b(main|master|prod|production|release)\b/)?.[1] ?? "main";
      return genericImpact(
        `Push directly to a protected branch ('${branch}'), bypassing PR review.`,
        [
          "Skips code review, CODEOWNERS, and required CI checks (unless branch protection rejects it)",
          "Will trigger any deploy pipelines wired to this branch",
        ],
        "yes",
      );
    } },
  { id: "git-reset-hard", category: "git", severity: "high",
    description: "Hard reset (destroys uncommitted work)",
    pattern: /\bgit\s+reset\s+--hard\b/,
    describe: () => genericImpact(
      "Discard all uncommitted changes and move HEAD — local work is lost.",
      [
        "Working tree and index are reset to the target commit",
        "Any modified-but-uncommitted files are unrecoverable",
        "Reflog can recover commits, but not unstaged file edits",
      ],
      "partial",
    ) },
  { id: "git-clean", category: "git", severity: "medium",
    description: "git clean -fd (deletes untracked files)",
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/,
    describe: () => genericImpact(
      "Permanently delete untracked files (and dirs) in the working tree.",
      [
        "Files that were never staged are gone — git reflog cannot recover them",
        "With -x: also deletes ignored files like .env and local DBs",
      ],
    ) },
  { id: "git-history-rewrite", category: "git", severity: "high",
    description: "Rewriting git history",
    pattern: /\bgit\s+(filter-branch|filter-repo|reflog\s+expire)\b/,
    describe: () => genericImpact(
      "Rewrite repository history — every commit SHA downstream changes.",
      [
        "Every collaborator must re-clone or rebase",
        "Open PRs get stranded against the old history",
        "Often used to remove accidentally-committed secrets — but the secret is still in any clones",
      ],
    ) },

  // ===== infra =====
  { id: "terraform-apply", category: "infra", severity: "high",
    description: "terraform apply / destroy",
    pattern: /\bterraform\s+(apply|destroy)\b/,
    describe: (cmd) => {
      const verb = cmd.match(/terraform\s+(apply|destroy)/)?.[1] ?? "apply";
      return genericImpact(
        verb === "destroy"
          ? "Destroy every resource managed by this Terraform state."
          : "Apply pending Terraform changes to real cloud infrastructure.",
        [
          verb === "destroy"
            ? "All resources in this state will be deleted in dependency order"
            : "Resources marked for destruction in the plan will be deleted; created/updated ones modified in the cloud",
          "State file is updated; rollback requires git-revert + re-apply",
          "Run 'terraform plan' first to see the exact diff",
        ],
      );
    } },
  { id: "kubectl-destructive", category: "infra", severity: "high",
    description: "Destructive kubectl",
    pattern: /\bkubectl\s+(delete|drain|cordon|patch|replace|apply\s+-f)\b/,
    describe: (cmd) => {
      const verb = cmd.match(/kubectl\s+(\w+)/)?.[1] ?? "?";
      const kind = cmd.match(/kubectl\s+\w+\s+(\w+)/)?.[1] ?? "(kind?)";
      const name = cmd.match(/kubectl\s+\w+\s+\w+\s+(\S+)/)?.[1];
      const ns = arg(cmd, "-n", "--namespace");
      const targets: Record<string, string> = { verb, kind };
      if (name) targets.name = name;
      if (ns) targets.namespace = ns;
      return {
        headline: `kubectl ${verb} ${kind}${name ? " " + name : ""}${ns ? " in ns " + ns : ""} — affects live cluster state.`,
        consequences: [
          verb === "delete"
            ? "Pods/Deployments/Services/etc. are removed; downstream traffic begins erroring immediately"
            : verb === "drain"
              ? "Node is marked unschedulable and pods are evicted"
              : verb === "patch" || verb === "replace"
                ? "Live resource definition is mutated — controllers reconcile to the new spec"
                : "Cluster state is mutated according to the manifest",
          "ReplicaSet/rollout history may be lost; 'rollout undo' may not work after this",
        ],
        recoverable: "partial",
        targets,
      };
    } },
  { id: "helm-destructive", category: "infra", severity: "high",
    description: "helm delete / uninstall / rollback",
    pattern: /\bhelm\s+(delete|uninstall|rollback)\b/,
    describe: (cmd) => {
      const release = cmd.match(/helm\s+(?:delete|uninstall|rollback)\s+(\S+)/)?.[1] ?? "(release?)";
      return {
        headline: `Tear down or roll back the Helm release '${release}'.`,
        consequences: [
          "All resources managed by this release are removed (or rolled back to a prior revision)",
          "PVCs may persist or vanish depending on release config — re-install rarely restores state",
        ],
        recoverable: "partial",
        targets: { release },
      };
    } },

  // ===== cloud =====
  { id: "aws-s3-rb", category: "cloud", severity: "high",
    description: "Delete S3 bucket",
    pattern: /\baws\s+s3\s+rb\b/,
    describe: (cmd) => {
      const bucket = cmd.match(/s3:\/\/(\S+)/)?.[1] ?? "(bucket?)";
      const force = /--force\b/.test(cmd);
      return {
        headline: `Permanently delete S3 bucket '${bucket}'${force ? " and all its objects" : ""}.`,
        consequences: [
          "Bucket name is released and may be claimed by other AWS accounts",
          "Lifecycle rules, policies, replication, and notifications are lost",
          force ? "All objects in the bucket are deleted before bucket removal" : "If the bucket is non-empty, the call fails (without --force)",
        ],
        recoverable: "no",
        targets: { bucket, force: String(force) },
      };
    } },
  { id: "aws-s3-rm-recursive", category: "cloud", severity: "high",
    description: "Recursive S3 delete",
    pattern: /\baws\s+s3\s+rm\s+.*--recursive\b/,
    describe: (cmd) => {
      const path = cmd.match(/s3:\/\/(\S+)/)?.[1] ?? "(path?)";
      return {
        headline: `Recursively delete every object under s3://${path}.`,
        consequences: [
          "All objects under the prefix are removed",
          "If versioning is off, objects are unrecoverable",
          "If versioning is on, delete-markers are added but storage cost continues",
        ],
        recoverable: "partial",
        targets: { path },
      };
    } },
  { id: "aws-s3-sync-delete", category: "data", severity: "high",
    description: "aws s3 sync --delete (silent destination wipe)",
    pattern: /\baws\s+s3\s+sync\b.*--delete\b/,
    describe: (cmd) => {
      const dest = cmd.match(/s3:\/\/(\S+)/g)?.slice(-1)[0] ?? "(dest?)";
      return {
        headline: `Sync to ${dest} and DELETE every destination object not present in the source.`,
        consequences: [
          "Files at the destination but not the source are removed without prompt",
          "If the source is empty or wrong, the destination is wiped",
          "Looks safe in code review — easy to miss the --delete flag",
        ],
        recoverable: "partial",
        targets: { destination: dest },
      };
    } },
  { id: "gsutil-rsync-delete", category: "data", severity: "high",
    description: "gsutil rsync -d (silent destination wipe)",
    pattern: /\bgsutil\s+(-m\s+)?rsync\s+.*-[rd]*d/,
    describe: () => genericImpact(
      "GCS rsync with -d — deletes destination files not present in source.",
      [
        "Same risk shape as 'aws s3 sync --delete'",
        "If the source is empty/wrong, the destination bucket is wiped",
      ],
      "partial",
    ) },
  { id: "rsync-delete", category: "data", severity: "medium",
    description: "rsync --delete",
    pattern: /\brsync\s+.*--delete(-\w+)?\b/,
    describe: () => genericImpact(
      "rsync with --delete — destination diverges from source by deleting extra files.",
      ["A wrong source path can wipe the destination", "No prompt"],
      "no",
    ) },
  { id: "aws-ec2-terminate", category: "cloud", severity: "high",
    description: "Terminate EC2 instances",
    pattern: /\baws\s+ec2\s+terminate-instances\b/,
    describe: (cmd) => {
      const ids = cmd.match(/--instance-ids\s+([\w\-,\s]+?)(?:\s+--|$)/)?.[1].trim() ?? "(ids?)";
      return {
        headline: `Terminate EC2 instances: ${ids}.`,
        consequences: [
          "Instance is shut down and removed; ephemeral storage is lost",
          "Any in-flight requests fail immediately (unless behind a load balancer that drains)",
          "EBS root volumes deleted unless DeleteOnTermination=false",
        ],
        recoverable: "no",
        targets: { instanceIds: ids },
      };
    } },
  { id: "aws-rds-destructive", category: "cloud", severity: "high",
    description: "RDS delete / stop / reboot",
    pattern: /\baws\s+rds\s+(delete|stop|reboot|restore)-db/,
    describe: (cmd) => {
      const verb = cmd.match(/aws\s+rds\s+(\w+)-db/)?.[1] ?? "?";
      return genericImpact(
        `RDS ${verb} on a database instance — affects production database availability.`,
        [
          verb === "delete" ? "Database instance is removed; final snapshot is taken only if requested" : "",
          verb === "reboot" ? "Database is unavailable for ~30s–5min depending on engine" : "",
          verb === "stop" ? "Instance is unavailable; auto-resumes after 7 days" : "",
        ].filter(Boolean),
      );
    } },
  { id: "gcloud-delete", category: "cloud", severity: "high",
    description: "gcloud delete",
    pattern: /\bgcloud\s+.*\bdelete\b/,
    describe: (cmd) => genericImpact(
      `gcloud delete operation: '${cmd.slice(0, 120)}'`,
      ["Resource removal in GCP — most operations are irreversible"],
    ) },
  { id: "az-delete", category: "cloud", severity: "high",
    description: "az delete",
    pattern: /\baz\s+.*\bdelete\b/,
    describe: (cmd) => genericImpact(
      `Azure CLI delete: '${cmd.slice(0, 120)}'`,
      ["Resource removal in Azure — most operations are irreversible"],
    ) },
  { id: "route53-delete", category: "network", severity: "high",
    description: "Route53 record DELETE",
    pattern: /\baws\s+route53\s+change-resource-record-sets\b.*DELETE/,
    describe: () => genericImpact(
      "Delete a Route53 DNS record — DNS resolution for the name will fail.",
      [
        "Cached DNS responses propagate for the TTL; new lookups fail immediately at authoritative servers",
        "Can break dependent services and SSL/TLS certificate renewal",
      ],
    ) },
  { id: "cloudflare-delete", category: "network", severity: "high",
    description: "Cloudflare zone/record delete",
    pattern: /\bcloudflare(-cli)?\s+.*\bdelete\b/,
    describe: () => genericImpact(
      "Delete a Cloudflare DNS / zone / WAF resource.",
      ["Production DNS or security configuration is removed"],
    ) },

  // ===== database =====
  { id: "sql-drop", category: "db", severity: "high",
    description: "DROP SQL statement",
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|USER|ROLE)\b/i,
    describe: (cmd) => {
      const obj = cmd.match(/DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|USER|ROLE)\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
      const kind = obj?.[1] ?? "(?)";
      const name = obj?.[2] ?? "(?)";
      return {
        headline: `DROP ${kind} ${name} — schema object is removed.`,
        consequences: [
          kind.toUpperCase() === "TABLE" ? "All rows in the table are deleted along with the table" : "",
          kind.toUpperCase() === "DATABASE" ? "Every table, view, function, and grant in the database is gone" : "",
          "Recovery requires a backup or PITR if available",
        ].filter(Boolean),
        recoverable: "no",
        targets: { kind, name },
      };
    } },
  { id: "sql-truncate", category: "db", severity: "high",
    description: "TRUNCATE SQL statement",
    pattern: /\bTRUNCATE\s+(TABLE\s+)?\w+/i,
    describe: (cmd) => {
      const tbl = cmd.match(/TRUNCATE\s+(?:TABLE\s+)?(\w+)/i)?.[1] ?? "(?)";
      return {
        headline: `TRUNCATE ${tbl} — every row removed in one transaction.`,
        consequences: [
          "Table structure is preserved; all rows are gone",
          "On most engines TRUNCATE is not logged row-by-row, so PITR may not recover",
          "Foreign key cascades may affect dependent tables",
        ],
        recoverable: "no",
        targets: { table: tbl },
      };
    } },
  { id: "sql-delete-no-where", category: "db", severity: "high",
    description: "DELETE without WHERE clause",
    pattern: /\bDELETE\s+FROM\s+\w+\s*(;|"|'|$)(?![^;]*\bWHERE\b)/i,
    describe: (cmd) => {
      const tbl = cmd.match(/DELETE\s+FROM\s+(\w+)/i)?.[1] ?? "(?)";
      return {
        headline: `DELETE FROM ${tbl} with no WHERE clause — every row deleted.`,
        consequences: [
          "All rows in the table are removed",
          "Slower than TRUNCATE but row-by-row, so PITR can usually recover",
        ],
        recoverable: "partial",
        targets: { table: tbl },
      };
    } },
  { id: "mongo-drop", category: "db", severity: "high",
    description: "MongoDB drop database/collection",
    pattern: /\bdb\.(dropDatabase\(\)|\w+\.drop\(\))/,
    describe: () => genericImpact(
      "MongoDB dropDatabase / collection.drop — entire DB or collection removed.",
      ["Documents are gone; index definitions are removed", "Backup or oplog replay is the only recovery"],
    ) },
  { id: "redis-flush", category: "db", severity: "high",
    description: "Redis FLUSHDB / FLUSHALL",
    pattern: /\b(FLUSHDB|FLUSHALL)\b/i,
    describe: () => genericImpact(
      "Redis FLUSH — wipes the current DB or every DB on the instance.",
      [
        "All keys removed instantly",
        "If running with no AOF/RDB, data is unrecoverable",
        "Connected clients suddenly see cache misses; can stampede the origin DB",
      ],
    ) },
  { id: "redis-keys-star", category: "db", severity: "medium",
    description: "Redis KEYS * (locks server)",
    pattern: /\bKEYS\s+["']?\*/i,
    describe: () => genericImpact(
      "Redis KEYS * — scans the entire keyspace, blocking the server while it runs.",
      ["Latency spikes for every other client", "Use SCAN instead in production"],
      "yes",
    ) },
  { id: "es-delete-all", category: "db", severity: "high",
    description: "Elasticsearch DELETE _all / index",
    pattern: /\b(DELETE|curl\s+-X\s*DELETE)\s+.*\/(_all|[a-z0-9_-]+)/i,
    describe: () => genericImpact(
      "Elasticsearch DELETE on an index (or _all).",
      ["Mappings and documents are removed", "Snapshot restore is the only recovery"],
    ) },
  { id: "bq-rm", category: "data", severity: "high",
    description: "BigQuery dataset/table delete",
    pattern: /\bbq\s+(rm|--force)\b/,
    describe: (cmd) => {
      const recursive = /-r\b/.test(cmd);
      const force = /-f\b/.test(cmd);
      const target = cmd.match(/bq\s+rm\s+(?:[-rf\s]+)?(\S+:?\S*)/)?.[1] ?? "(?)";
      return {
        headline: `BigQuery rm of ${target}${recursive ? " (recursive)" : ""}${force ? " (no prompt)" : ""}.`,
        consequences: [
          "Dataset / table is deleted",
          force ? "No interactive confirmation — runs immediately" : "",
          "Time-travel allows recovery within 7 days; after that, gone",
        ].filter(Boolean),
        recoverable: "partial",
        targets: { target },
      };
    } },
  { id: "snowflake-destructive", category: "data", severity: "high",
    description: "Snowflake DROP / TRUNCATE / DELETE",
    pattern: /\b(DROP\s+(DATABASE|SCHEMA|WAREHOUSE|TABLE|STAGE|PIPE|STREAM|TASK)|TRUNCATE\s+TABLE)\b/i,
    describe: () => genericImpact(
      "Snowflake destructive DDL.",
      ["Time Travel (default 1 day, up to 90) allows undrop within window", "After Time Travel: Fail-safe (7 days, Snowflake-only recovery)"],
      "partial",
    ) },
  { id: "hdfs-rm", category: "data", severity: "high",
    description: "HDFS / Hadoop recursive delete",
    pattern: /\b(hdfs\s+dfs|hadoop\s+fs)\s+(-rm\s+-r|-rmr|-rm\s+-skipTrash)/,
    describe: () => genericImpact(
      "HDFS recursive delete (often with -skipTrash).",
      ["Files removed from the cluster", "If trash is bypassed, no recovery without snapshot"],
    ) },
  { id: "databricks-rm", category: "data", severity: "high",
    description: "Databricks DBFS rm -r / workspace delete",
    pattern: /\bdatabricks\s+(fs\s+rm\s+-r|workspace\s+delete|jobs\s+delete|clusters\s+permanent-delete)/,
    describe: () => genericImpact(
      "Databricks destructive operation (DBFS rm -r, workspace delete, job/cluster delete).",
      ["Affects shared workspace state", "Workspace items may be unrecoverable"],
    ) },
  { id: "migration-rollback", category: "db", severity: "high",
    description: "Migration tool destructive op",
    pattern: /\b(alembic\s+downgrade|flyway\s+clean|prisma\s+migrate\s+reset|knex\s+migrate:rollback\s+--all|sequelize\s+db:migrate:undo:all|django-admin\s+migrate\s+\w+\s+zero)/,
    describe: () => genericImpact(
      "Migration rollback — schema and often data are reverted (or wiped).",
      [
        "'flyway clean' drops every object the schema owner created",
        "'prisma migrate reset' wipes the dev database",
        "'alembic downgrade' / 'knex rollback' may DROP columns and lose data",
      ],
    ) },
  { id: "pg-restore-clean", category: "db", severity: "high",
    description: "pg_restore --clean (drops first)",
    pattern: /\bpg_restore\b.*--clean\b/,
    describe: () => genericImpact(
      "pg_restore with --clean drops existing objects before restore.",
      ["Existing tables are dropped before being recreated from the dump", "If the dump is incomplete, you have neither the new nor the old data"],
    ) },

  // ===== ml / model registry =====
  { id: "mlflow-prod-stage", category: "ml", severity: "high",
    description: "MLflow transition to Production",
    pattern: /\bmlflow\s+models?\s+(transition-stage|update-stage)\b.*Production\b/,
    describe: () => genericImpact(
      "Promote a model version to MLflow's Production stage.",
      [
        "Anything routing on stage='Production' starts using the new version immediately",
        "Common cause of silent quality regressions if no shadow eval was run",
      ],
      "yes",
    ) },
  { id: "sagemaker-endpoint", category: "ml", severity: "high",
    description: "SageMaker endpoint create/update/delete",
    pattern: /\baws\s+sagemaker\s+(create-endpoint|update-endpoint|delete-endpoint|create-endpoint-config)/,
    describe: (cmd) => {
      const verb = cmd.match(/sagemaker\s+(\S+)/)?.[1] ?? "?";
      return genericImpact(
        `SageMaker ${verb} — production inference endpoint mutation.`,
        [
          verb === "delete-endpoint" ? "Endpoint is removed; clients calling it fail" : "",
          verb === "update-endpoint" ? "New endpoint config is rolled in; traffic shifts to the new model" : "",
          verb === "create-endpoint" ? "New endpoint is provisioned and starts serving" : "",
          "Cost: instances run continuously; mistakes are billable",
        ].filter(Boolean),
      );
    } },
  { id: "vertex-ai-deploy", category: "ml", severity: "high",
    description: "Vertex AI deploy / undeploy",
    pattern: /\bgcloud\s+ai\s+endpoints\s+(deploy-model|undeploy-model)/,
    describe: () => genericImpact(
      "Vertex AI endpoint deploy/undeploy — production routing change.",
      ["Live inference traffic shifts to the new model (or fails on undeploy)"],
    ) },
  { id: "azureml-endpoint", category: "ml", severity: "high",
    description: "Azure ML online endpoint mutation",
    pattern: /\baz\s+ml\s+online-endpoint\s+(create|update|delete)/,
    describe: () => genericImpact(
      "Azure ML online endpoint create/update/delete.",
      ["Production inference behavior changes immediately"],
    ) },
  { id: "huggingface-upload", category: "ml", severity: "medium",
    description: "Huggingface push (model/dataset)",
    pattern: /\bhuggingface-cli\s+upload\b|\bhf\s+upload\b|\bhf_hub_download\s*\(\s*[^)]*write\s*=\s*True/,
    describe: () => genericImpact(
      "Push a model/dataset to the Huggingface Hub.",
      ["If the repo is public, content is published to the world (cannot be unpublished cleanly)", "Model weights or training data may be exposed if the repo's privacy is wrong"],
      "no",
    ) },
  { id: "wandb-delete", category: "ml", severity: "medium",
    description: "Weights & Biases delete",
    pattern: /\bwandb\s+(artifact|run)\s+delete\b/,
    describe: () => genericImpact(
      "W&B delete — removes a run or artifact.",
      ["Lineage is lost; downstream runs that referenced the artifact may fail"],
    ) },
  { id: "dvc-destructive", category: "ml", severity: "medium",
    description: "DVC remove / gc",
    pattern: /\bdvc\s+(remove|gc)\b/,
    describe: () => genericImpact(
      "DVC remove or garbage-collect — data version is removed from cache/remote.",
      ["Older snapshots may become unreachable", "gc -f -c removes objects from cloud remote permanently"],
    ) },
  { id: "feast-apply", category: "ml", severity: "medium",
    description: "Feast feature store apply",
    pattern: /\bfeast\s+(apply|teardown)\b/,
    describe: (cmd) => {
      const verb = cmd.match(/feast\s+(\w+)/)?.[1] ?? "?";
      return genericImpact(
        `Feast ${verb} — feature store schema/infra is mutated.`,
        [
          verb === "teardown" ? "Online and offline stores are torn down" : "Feature views, entities, and online schemas are reconciled to the registry",
          "Online consumers may see schema changes mid-flight",
        ],
      );
    } },
  { id: "tecton-apply", category: "ml", severity: "medium",
    description: "Tecton apply",
    pattern: /\btecton\s+(apply|destroy)\b/,
    describe: () => genericImpact(
      "Tecton apply/destroy — production feature platform mutation.",
      ["Feature definitions in production are altered or removed"],
    ) },
  { id: "vector-db-delete", category: "ml", severity: "high",
    description: "Vector DB index/collection delete",
    pattern: /\b(pinecone\s+(index|collection)\s+delete|weaviate\s+schema\s+delete|qdrant\s+collections?\s+delete)/,
    describe: () => genericImpact(
      "Delete a vector DB collection / index.",
      ["All embeddings and metadata in the collection are removed", "Re-indexing usually means re-embedding the corpus from source documents"],
    ) },

  // ===== gitops =====
  { id: "argocd-destructive", category: "gitops", severity: "high",
    description: "argocd app delete / sync --prune",
    pattern: /\bargocd\s+app\s+(delete|sync\b.*--prune)/,
    describe: () => genericImpact(
      "ArgoCD app delete / sync --prune — Kubernetes resources removed by GitOps.",
      ["--prune removes resources that are no longer in the manifest", "Cascade delete affects everything the app manages"],
    ) },
  { id: "flux-destructive", category: "gitops", severity: "high",
    description: "flux suspend / delete",
    pattern: /\bflux\s+(suspend|delete|uninstall)\b/,
    describe: () => genericImpact(
      "Flux destructive operation — suspends reconciliation or removes resources.",
      ["Suspend halts auto-sync; state can drift", "Delete removes Kustomizations, HelmReleases, or sources"],
    ) },
  { id: "argo-rollouts-abort", category: "gitops", severity: "medium",
    description: "argo rollouts abort / undo",
    pattern: /\bargo\s+rollouts?\s+(abort|undo)\b/,
    describe: () => genericImpact(
      "Abort or undo an Argo Rollout — traffic shifts back / canary halted.",
      ["Often the right move during an incident, but should still be approved deliberately"],
      "yes",
    ) },

  // ===== ci/cd =====
  { id: "gh-secret-remove", category: "ci-cd", severity: "high",
    description: "Delete a GitHub Actions secret",
    pattern: /\bgh\s+secret\s+(remove|delete)\b/,
    describe: (cmd) => {
      const name = cmd.match(/gh\s+secret\s+(?:remove|delete)\s+(\S+)/)?.[1] ?? "(?)";
      return {
        headline: `Delete GitHub secret '${name}' — workflows depending on it will start failing.`,
        consequences: [
          "Any workflow referencing this secret breaks on next run",
          "Secret value is unrecoverable; you must re-add a fresh one",
        ],
        recoverable: "no",
        targets: { name },
      };
    } },
  { id: "gh-workflow-disable", category: "ci-cd", severity: "high",
    description: "Disable a GitHub Actions workflow",
    pattern: /\bgh\s+workflow\s+(disable|delete)\b/,
    describe: () => genericImpact(
      "Disable or delete a GitHub Actions workflow.",
      [
        "All scheduled and event-triggered runs of this workflow stop",
        "Often used to silence a noisy CI check before fixing the underlying issue",
      ],
      "yes",
    ) },
  { id: "gh-repo-delete", category: "ci-cd", severity: "high",
    description: "Delete a GitHub repository",
    pattern: /\bgh\s+repo\s+delete\b/,
    describe: (cmd) => {
      const repo = cmd.match(/gh\s+repo\s+delete\s+(\S+)/)?.[1] ?? "(current repo)";
      return {
        headline: `Delete the GitHub repository ${repo}.`,
        consequences: [
          "Repository, issues, PRs, releases, packages, and Actions secrets are removed",
          "GitHub keeps a 90-day window where org owners can restore",
        ],
        recoverable: "partial",
        targets: { repo },
      };
    } },
  { id: "gh-pr-merge-admin", category: "ci-cd", severity: "high",
    description: "Merge PR with --admin (bypasses required checks)",
    pattern: /\bgh\s+pr\s+merge\b.*--admin\b/,
    describe: () => genericImpact(
      "Merge a PR using admin privileges, bypassing required reviewers and checks.",
      [
        "Branch protection rules (required reviews, status checks) are skipped",
        "Audit logs will show this was force-merged",
      ],
      "yes",
    ) },
  { id: "vercel-env-rm", category: "ci-cd", severity: "high",
    description: "Vercel env var remove",
    pattern: /\bvercel\s+env\s+(rm|remove)\b/,
    describe: () => genericImpact(
      "Remove a Vercel env var — next deploy is missing the variable.",
      ["Apps that read this var at runtime will break on next deploy"],
    ) },
  { id: "netlify-env-unset", category: "ci-cd", severity: "high",
    description: "Netlify env unset",
    pattern: /\bnetlify\s+env:unset\b/,
    describe: () => genericImpact(
      "Unset a Netlify env var — same risk as Vercel above.",
      ["Apps reading this var break on next deploy"],
    ) },
  { id: "heroku-config-unset", category: "ci-cd", severity: "high",
    description: "Heroku config unset",
    pattern: /\bheroku\s+config:(unset|remove)\b/,
    describe: () => genericImpact(
      "Heroku config unset — env var removed and app restarts.",
      ["Heroku auto-restarts the dyno; if the app needs the var, it crash-loops"],
    ) },
  { id: "circleci-delete", category: "ci-cd", severity: "medium",
    description: "CircleCI destructive",
    pattern: /\bcircleci\s+(pipeline\s+cancel|context\s+delete|orb\s+remove)/,
    describe: () => genericImpact(
      "CircleCI destructive operation.",
      ["Cancels or removes shared CI state; affects every run that depends on it"],
    ) },

  // ===== iam / secrets =====
  { id: "iam-destructive", category: "iam", severity: "high",
    description: "IAM user/role/policy delete or admin attach",
    pattern: /\baws\s+iam\s+(delete-(user|role|policy|access-key)|attach-(user|role)-policy.*AdministratorAccess)/,
    describe: (cmd) => {
      const op = cmd.match(/iam\s+(\S+)/)?.[1] ?? "?";
      return {
        headline: `IAM ${op} — identity / permissions mutated in your AWS account.`,
        consequences: [
          op.startsWith("delete-") ? "Deleted identity / policy is permanently removed; dependent services lose access" : "",
          op.startsWith("attach-") ? "Privilege escalation — entity gains AdministratorAccess (full account)" : "",
          "All such changes are recorded in CloudTrail",
        ].filter(Boolean),
        recoverable: "no" as const,
      };
    } },
  { id: "vault-destructive", category: "secrets", severity: "high",
    description: "HashiCorp Vault destructive",
    pattern: /\bvault\s+(delete|kv\s+(destroy|delete)|policy\s+delete|namespace\s+delete)\b/,
    describe: () => genericImpact(
      "Vault destructive operation — secret, policy, or namespace removed.",
      ["'kv destroy' removes specific versions; 'kv delete' soft-deletes (recoverable)", "'delete' on namespaces/policies cascades"],
      "partial",
    ) },
  { id: "aws-secretsmanager-delete", category: "secrets", severity: "high",
    description: "AWS Secrets Manager delete-secret",
    pattern: /\baws\s+secretsmanager\s+delete-secret\b/,
    describe: (cmd) => {
      const force = /--force-delete-without-recovery/.test(cmd);
      return {
        headline: force ? "Permanently delete an AWS secret (no recovery)." : "Schedule deletion of an AWS secret (default 30-day window).",
        consequences: [
          force ? "Secret value is gone immediately" : "Secret enters a recovery window; can be cancelled",
          "All applications still reading this secret will fail",
        ],
        recoverable: force ? "no" : "partial",
      };
    } },
  { id: "gcp-secrets-delete", category: "secrets", severity: "high",
    description: "GCP secrets delete",
    pattern: /\bgcloud\s+secrets\s+(delete|versions\s+destroy)/,
    describe: () => genericImpact(
      "GCP Secret Manager delete / version destroy.",
      ["Secret payload is removed; consumers fail on next read"],
    ) },
  { id: "k8s-cluster-admin-bind", category: "iam", severity: "high",
    description: "Bind cluster-admin via kubectl",
    pattern: /\bkubectl\s+create\s+(cluster)?rolebinding\b.*cluster-admin\b/,
    describe: () => genericImpact(
      "Grant cluster-admin (root in the cluster) to a user/group/SA.",
      ["Recipient gets full mutating power over every resource in every namespace", "Privilege escalation — typically the wrong fix during an incident"],
    ) },

  // ===== system =====
  { id: "crontab-r", category: "system", severity: "high",
    description: "crontab -r (silent wipe)",
    pattern: /\bcrontab\s+-r\b/,
    describe: () => genericImpact(
      "crontab -r — wipes the user's crontab with NO confirmation.",
      [
        "Single-keystroke distance from 'crontab -e' (notorious typo)",
        "All scheduled jobs for this user are removed immediately",
        "If you don't have a backup of the crontab, it's gone",
      ],
    ) },
  { id: "systemctl-stop-disable", category: "system", severity: "high",
    description: "systemctl stop/disable/mask",
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/,
    describe: (cmd) => {
      const unit = cmd.match(/systemctl\s+\w+\s+(\S+)/)?.[1] ?? "(unit?)";
      return genericImpact(
        `Stop/disable/mask the systemd unit '${unit}'.`,
        ["Service stops immediately; clients depending on it begin failing", "If 'mask', restart attempts also fail until unmasked"],
        "yes",
      );
    } },
  { id: "shutdown-reboot", category: "system", severity: "high",
    description: "shutdown / reboot / halt",
    pattern: /\b(shutdown\b|reboot\b|halt\b|init\s+[06]\b)/,
    describe: () => genericImpact(
      "Reboot or shut down the host.",
      ["All running processes terminate", "If this is a single-host service, downtime begins immediately"],
      "yes",
    ) },
  { id: "kill-init", category: "system", severity: "high",
    description: "kill -9 1 / killall -9",
    pattern: /\b(kill\s+-9\s+1\b|killall\s+-9\s+(?!-)\S+)/,
    describe: () => genericImpact(
      "Kill PID 1 or send SIGKILL to processes by name.",
      ["kill -9 1 typically panics the kernel (or is a no-op)", "killall -9 with a broad pattern can take down half the host"],
    ) },

  // ===== container / supply chain =====
  { id: "docker-prune", category: "container", severity: "medium",
    description: "docker system prune -a",
    pattern: /\bdocker\s+system\s+prune\b.*\b-a\b/,
    describe: () => genericImpact(
      "docker system prune -a — removes ALL stopped containers, unused networks, dangling AND tagged images.",
      ["Pulls and rebuilds will be needed for any image not currently in use", "Slow recovery if local registry is also pruned"],
      "yes",
    ) },
  { id: "ecr-delete", category: "container", severity: "high",
    description: "ECR repository delete",
    pattern: /\baws\s+ecr\s+delete-repository\b/,
    describe: () => genericImpact(
      "Delete an ECR repository — all image tags and digests are removed.",
      ["Deployments that pull by tag will fail", "If --force, all images are deleted before repo removal"],
    ) },
  { id: "publish-package", category: "supply-chain", severity: "high",
    description: "Publish a package to a public registry",
    pattern: /\b(npm|yarn|pnpm)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bpoetry\s+publish\b/,
    describe: () => genericImpact(
      "Publish a package to a public package registry.",
      [
        "Once published, anyone in the world can install it",
        "npm 'unpublish' is restricted (>72h windows blocked)",
        "Mistakes can leak proprietary code or credentials",
      ],
    ) },
  { id: "gh-release-create", category: "supply-chain", severity: "high",
    description: "Create or delete a GitHub release",
    pattern: /\bgh\s+release\s+(create|delete)\b/,
    describe: () => genericImpact(
      "Create / delete a GitHub release — affects published artifacts and tags.",
      ["Creating a release fires release-triggered workflows (often deploys)", "Deleting a release removes assets users may already depend on"],
    ) },
  { id: "curl-pipe-shell", category: "supply-chain", severity: "high",
    description: "Pipe network download into shell",
    pattern: /\b(curl|wget)\b[^|]*\|\s*(bash|sh|zsh|fish|ksh)\b/,
    describe: () => genericImpact(
      "Pipe an HTTP response straight into a shell.",
      [
        "If the server is compromised, code runs as the current user",
        "No integrity check — a TOFU model with no verification",
      ],
    ) },
  { id: "chmod-777", category: "filesystem", severity: "medium",
    description: "World-writable permissions",
    pattern: /\bchmod\s+(-R\s+)?(0?777|a\+w)\b/,
    describe: () => genericImpact(
      "Set permissions to world-writable.",
      ["Any process on the host can modify these files", "On shared hosts, this is a privilege escalation primitive"],
      "yes",
    ) },

  // ===== network =====
  { id: "iptables-flush", category: "network", severity: "high",
    description: "iptables flush / nft flush",
    pattern: /\b(iptables\s+(-F|-X)|nft\s+flush\s+ruleset)\b/,
    describe: () => genericImpact(
      "Flush firewall rules — host firewall is wide open.",
      ["All filtering chains are emptied", "On a hardened host, exposes services that were only firewall-protected"],
    ) },
  { id: "reverse-tunnel", category: "network", severity: "medium",
    description: "Reverse tunnel / listening socket",
    pattern: /\b(ssh\s+-R\b|socat\s+.*LISTEN|nc\s+-l\b|python3?\s+-m\s+http\.server\b)/,
    describe: () => genericImpact(
      "Open a reverse tunnel or local listening socket.",
      [
        "Sometimes legitimate (port-forward for debugging)",
        "Sometimes an exfiltration channel — depends on context",
      ],
      "yes",
    ) },
  // ----- HTTP / network write surface (the curl + bearer + mutation family) -----
  { id: "http-destructive-payload", category: "network", severity: "high",
    description: "HTTP call carrying a destructive payload (GraphQL/REST)",
    // catches calls whose payload includes mutating verbs against any HTTP client
    pattern:
      /\b(curl|wget|http|https|httpie|xh|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*?\b(mutation\s*\{[\s\S]*?(delete|destroy|drop|terminate|shutdown|cancel|remove|destroy|revoke)|"(action|op|operation)"\s*:\s*"(delete|destroy|drop|terminate|shutdown|cancel|remove|revoke)")/i,
    describe: (cmd) => {
      const url = (cmd.match(/https?:\/\/[^\s'"]+/i) ?? [""])[0];
      const verb = (cmd.match(/\b(delete|destroy|drop|terminate|shutdown|cancel|remove|revoke)\w*/i) ?? [""])[0];
      return {
        headline: `HTTP call with destructive payload (${verb || "mutation"}) to ${url || "external service"}`,
        consequences: [
          "Body contains a mutation/REST verb that destroys or revokes external state",
          "These are typically irreversible on the receiving service",
          "Examples: GraphQL `mutation { volumeDelete(...) }`, REST `{\"action\":\"terminate\"}`",
        ],
        recoverable: "no",
        targets: { url, verb },
      };
    } },
  { id: "http-bearer-auth", category: "network", severity: "high",
    description: "HTTP call with Authorization: Bearer (credentialed)",
    // any curl/wget/http/PowerShell HTTP carrying a Bearer token — likely
    // using a credential against a remote API
    pattern:
      /\b(curl|wget|http|https|httpie|xh|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*?(Authorization\s*:\s*Bearer\b|--oauth2-bearer\b|-H\s+["']?Authorization)/i,
    describe: (cmd) => {
      const url = (cmd.match(/https?:\/\/[^\s'"]+/i) ?? [""])[0];
      return {
        headline: `Authenticated HTTP call to ${url || "external service"}`,
        consequences: [
          "Carrying a Bearer token / API key to a remote service",
          "If the token is leaked or scoped wrong, this can mutate external state under the agent's identity",
          "Self-preserving / scope-drifting agents often surface here first",
        ],
        recoverable: "unknown",
        targets: { url },
      };
    } },
  { id: "http-write-method", category: "network", severity: "medium",
    description: "HTTP call using a write method (POST/PUT/PATCH/DELETE)",
    // generic: any explicit write-method HTTP from common CLIs
    pattern:
      /\b(?:(?:curl|xh|httpie)\b[\s\S]*?(?:-X\s*|--request\s+)?(POST|PUT|PATCH|DELETE)\b|wget\b[\s\S]*?(?:--method=(POST|PUT|PATCH|DELETE)|--post-(?:data|file)\b)|http(?:s)?\s+(POST|PUT|PATCH|DELETE)\b|Invoke-(?:WebRequest|RestMethod)\b[\s\S]*?-Method\s+(POST|PUT|PATCH|DELETE))/i,
    describe: (cmd) => {
      const method =
        (cmd.match(/\b(POST|PUT|PATCH|DELETE)\b/i) ?? [""])[0].toUpperCase();
      const url = (cmd.match(/https?:\/\/[^\s'"]+/i) ?? [""])[0];
      return {
        headline: `HTTP ${method || "write"} to ${url || "external service"}`,
        consequences: [
          "Mutates state on a remote service",
          "Effects depend on the target — refunds, deletions, IAM changes, deploy triggers, etc.",
          "Pair with Authorization headers? Treat as credentialed write.",
        ],
        recoverable: "unknown",
        targets: { method, url },
      };
    } },
  { id: "inline-script-http-write", category: "network", severity: "high",
    description: "Inline interpreter (python/node/ruby/perl) issuing HTTP write",
    // Catches `python -c`, `node -e`, `ruby -e`, `perl -e` whose body
    // contains an HTTP-library reference AND a write verb. Two-step so
    // libraries imported via require/import + chained .delete still match.
    pattern:
      /\b(python3?|node|deno|bun|ruby|perl)\b[\s\S]*?(?:-c|-e|--eval|--exec)\b[\s\S]*?(?:axios|got|httpx|aiohttp|requests|urllib|node-fetch|undici|http\.client|net::http|net\/http|lwp::useragent|http::tiny|fetch\(|XMLHttpRequest)[\s\S]{0,400}?(?:\.(post|put|patch|delete)\s*\(|method\s*:\s*["'](POST|PUT|PATCH|DELETE)|"(?:POST|PUT|PATCH|DELETE)"|\b(POST|PUT|PATCH|DELETE)\b)/i,
    describe: (cmd) => {
      const interp = (cmd.match(/\b(python3?|node|deno|bun|ruby|perl)\b/i) ?? [""])[0];
      const verb =
        (cmd.match(/\b(POST|PUT|PATCH|DELETE)\b/i)?.[0]?.toUpperCase()) ||
        (cmd.match(/\.(post|put|patch|delete)\b/i)?.[1]?.toUpperCase()) ||
        "write";
      return {
        headline: `inline ${interp} script issuing HTTP ${verb}`,
        consequences: [
          "Script-level HTTP bypasses curl/wget rules",
          "Often used to dodge static command scanners",
          "Same destructive potential as a direct curl",
        ],
        recoverable: "unknown",
        targets: { interpreter: interp, verb },
      };
    } },
  { id: "http-control-endpoint", category: "infra", severity: "high",
    description: "HTTP call to a probable control-plane / admin endpoint",
    // URLs whose path strongly suggests admin/control/IAM/billing surface
    pattern:
      /https?:\/\/[^\s'"]*\/(?:admin|control|cancel-shutdown|disable|shutdown|terminate|destroy|iam|tokens?|api-keys?|secrets?|billing|payouts?|policies|quarantine|graphql)(?:[\/?][^\s'"]*)?/i,
    describe: (cmd) => {
      const url = (cmd.match(/https?:\/\/[^\s'"]+/i) ?? [""])[0];
      return {
        headline: `HTTP call to control-plane-shaped URL: ${url}`,
        consequences: [
          "Path looks like an admin/control/IAM/billing surface",
          "These endpoints generally make irreversible changes",
          "Likely outside the scope of a routine task agent",
        ],
        recoverable: "no",
        targets: { url },
      };
    } },
];

// ---------- PATH RULES ----------

const PATH_RULES: PathRule[] = [
  { id: "edit-env", category: "secrets", severity: "high",
    description: "Editing .env / secrets file",
    pattern: /(^|\/)\.env(\.|$|\/)/,
    describe: (path) => ({
      headline: `Edit '${path}' — env file likely contains secrets and runtime config.`,
      consequences: [
        "Local writes can break the app immediately if a required var is removed",
        "Env files are commonly gitignored — change is invisible in git history",
      ],
      recoverable: "yes",
      targets: { path },
    }) },
  { id: "edit-secrets-dir", category: "secrets", severity: "high",
    description: "Editing inside a secrets directory",
    pattern: /(^|\/)(secret|secrets|credentials?)(\/|$)/i,
    describe: (path) => ({
      headline: `Edit a file inside a secrets directory: ${path}`,
      consequences: ["Files in this dir are typically credentials, tokens, or keys"],
      recoverable: "yes",
      targets: { path },
    }) },
  { id: "edit-private-key", category: "secrets", severity: "high",
    description: "Editing a private key or cert",
    pattern: /(id_(rsa|ed25519|ecdsa|dsa)|\.pem$|\.key$|\.p12$|\.pfx$)/,
    describe: (path) => ({
      headline: `Edit a private key / certificate: ${path}`,
      consequences: [
        "Modifying the key invalidates everything signed by it",
        "If overwritten, the original key may be unrecoverable",
      ],
      recoverable: "no",
      targets: { path },
    }) },
  { id: "edit-prod-dir", category: "infra", severity: "medium",
    description: "Editing a file under a 'prod' or 'production' directory",
    pattern: /(^|\/)(prod|production)(\/|$)/i,
    describe: (path) => ({
      headline: `Edit a file in a 'prod'/'production' directory: ${path}`,
      consequences: ["Path naming convention suggests this is production config"],
      recoverable: "yes",
      targets: { path },
    }) },
  { id: "edit-terraform-state", category: "infra", severity: "high",
    description: "Editing terraform state",
    pattern: /(terraform\.tfstate(\.|$)|\.tfstate$)/,
    describe: (path) => ({
      headline: `Edit Terraform state file: ${path}`,
      consequences: [
        "State files should never be hand-edited — they map cloud resources to TF identifiers",
        "Manual edits cause drift, orphaned resources, and reapply errors",
      ],
      recoverable: "no",
      targets: { path },
    }) },
];

// ---------- evaluator ----------

export function evaluate(payload: ToolPayload): RuleMatch | null {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (!cmd) return null;
    for (const r of BASH_RULES) {
      const m = r.pattern.exec(cmd);
      if (m) {
        return {
          ruleId: r.id,
          category: r.category,
          severity: r.severity,
          description: r.description,
          impact: r.describe(cmd, m),
        };
      }
    }
    return null;
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    if (!path) return null;
    for (const r of PATH_RULES) {
      const m = r.pattern.exec(path);
      if (m) {
        return {
          ruleId: r.id,
          category: r.category,
          severity: r.severity,
          description: r.description,
          impact: r.describe(path, m),
        };
      }
    }
    return null;
  }

  return null;
}
