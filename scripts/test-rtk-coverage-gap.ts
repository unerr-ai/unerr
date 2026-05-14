/**
 * Test: How well does our existing pipeline handle the tools RTK has dedicated filters for?
 * These are tools we DON'T have per-tool filters for — RTK does.
 * If our classifier + strategy/omni handles them well, per-tool filters are unnecessary.
 */

import { compressShellOutput } from "../src/proxy/shell-compressor.js";

interface TestCase {
  label: string;
  command: string;
  output: string;
}

// ── Terraform ──────────────────────────────────────────────
const terraformPlan = `
Terraform used the selected providers to generate the following execution plan.
Resource actions are indicated with the following symbols:
  + create
  ~ update in-place
  - destroy

Terraform will perform the following actions:

  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami                          = "ami-0c55b159cbfafe1f0"
      + arn                          = (known after apply)
      + associate_public_ip_address  = true
      + availability_zone            = (known after apply)
      + cpu_core_count               = (known after apply)
      + cpu_threads_per_core         = (known after apply)
      + disable_api_stop             = (known after apply)
      + disable_api_termination      = (known after apply)
      + ebs_optimized                = (known after apply)
      + get_password_data            = false
      + host_id                      = (known after apply)
      + host_resource_group_arn      = (known after apply)
      + iam_instance_profile         = (known after apply)
      + id                           = (known after apply)
      + instance_initiated_shutdown_behavior = (known after apply)
      + instance_state               = (known after apply)
      + instance_type                = "t3.micro"
      + ipv6_address_count           = (known after apply)
      + ipv6_addresses               = (known after apply)
      + key_name                     = "my-key"
      + monitoring                   = false
      + outpost_arn                  = (known after apply)
      + password_data                = (known after apply)
      + placement_group              = (known after apply)
      + placement_partition_number   = (known after apply)
      + primary_network_interface_id = (known after apply)
      + private_dns                  = (known after apply)
      + private_ip                   = (known after apply)
      + public_dns                   = (known after apply)
      + public_ip                    = (known after apply)
      + secondary_private_ips        = (known after apply)
      + security_groups              = (known after apply)
      + source_dest_check            = true
      + subnet_id                    = (known after apply)
      + tags                         = {
          + "Environment" = "production"
          + "Name"        = "web-server"
          + "Team"        = "platform"
        }
      + tags_all                     = (known after apply)
      + tenancy                      = (known after apply)
      + user_data                    = (known after apply)
      + user_data_base64             = (known after apply)
      + user_data_replace_on_change  = false
      + vpc_security_group_ids       = (known after apply)
    }

  # aws_instance.api will be created
  + resource "aws_instance" "api" {
      + ami                          = "ami-0c55b159cbfafe1f0"
      + arn                          = (known after apply)
      + associate_public_ip_address  = true
      + availability_zone            = (known after apply)
      + cpu_core_count               = (known after apply)
      + cpu_threads_per_core         = (known after apply)
      + disable_api_stop             = (known after apply)
      + disable_api_termination      = (known after apply)
      + ebs_optimized                = (known after apply)
      + get_password_data            = false
      + host_id                      = (known after apply)
      + host_resource_group_arn      = (known after apply)
      + iam_instance_profile         = (known after apply)
      + id                           = (known after apply)
      + instance_initiated_shutdown_behavior = (known after apply)
      + instance_state               = (known after apply)
      + instance_type                = "t3.large"
      + ipv6_address_count           = (known after apply)
      + ipv6_addresses               = (known after apply)
      + key_name                     = "my-key"
      + monitoring                   = true
      + outpost_arn                  = (known after apply)
      + password_data                = (known after apply)
      + placement_group              = (known after apply)
      + placement_partition_number   = (known after apply)
      + primary_network_interface_id = (known after apply)
      + private_dns                  = (known after apply)
      + private_ip                   = (known after apply)
      + public_dns                   = (known after apply)
      + public_ip                    = (known after apply)
      + secondary_private_ips        = (known after apply)
      + security_groups              = (known after apply)
      + source_dest_check            = true
      + subnet_id                    = (known after apply)
      + tags                         = {
          + "Environment" = "production"
          + "Name"        = "api-server"
          + "Team"        = "platform"
        }
      + tags_all                     = (known after apply)
      + tenancy                      = (known after apply)
      + user_data                    = (known after apply)
      + user_data_base64             = (known after apply)
      + user_data_replace_on_change  = false
      + vpc_security_group_ids       = (known after apply)
    }

  # aws_security_group.web will be created
  + resource "aws_security_group" "web" {
      + arn                    = (known after apply)
      + description            = "Allow web traffic"
      + egress                 = [
          + {
              + cidr_blocks      = ["0.0.0.0/0"]
              + from_port        = 0
              + ipv6_cidr_blocks = []
              + prefix_list_ids  = []
              + protocol         = "-1"
              + security_groups  = []
              + self             = false
              + to_port          = 0
            },
        ]
      + id                     = (known after apply)
      + ingress                = [
          + {
              + cidr_blocks      = ["0.0.0.0/0"]
              + from_port        = 443
              + ipv6_cidr_blocks = []
              + prefix_list_ids  = []
              + protocol         = "tcp"
              + security_groups  = []
              + self             = false
              + to_port          = 443
            },
          + {
              + cidr_blocks      = ["0.0.0.0/0"]
              + from_port        = 80
              + ipv6_cidr_blocks = []
              + prefix_list_ids  = []
              + protocol         = "tcp"
              + security_groups  = []
              + self             = false
              + to_port          = 80
            },
        ]
      + name                   = "web-sg"
      + name_prefix            = (known after apply)
      + owner_id               = (known after apply)
      + revoke_rules_on_delete = false
      + tags                   = {
          + "Name" = "web-sg"
        }
      + tags_all               = (known after apply)
      + vpc_id                 = "vpc-abc123"
    }

  # aws_db_instance.main will be updated in-place
  ~ resource "aws_db_instance" "main" {
        id                     = "main-db"
      ~ instance_class         = "db.t3.medium" -> "db.t3.large"
        tags                   = {
            "Name" = "main-db"
        }
    }

  # aws_s3_bucket.old_logs will be destroyed
  - resource "aws_s3_bucket" "old_logs" {
      - arn                    = "arn:aws:s3:::old-logs-bucket" -> null
      - bucket                 = "old-logs-bucket" -> null
      - force_destroy          = false -> null
      - id                     = "old-logs-bucket" -> null
      - tags                   = {} -> null
      - tags_all               = {} -> null
    }

Plan: 3 to add, 1 to change, 1 to destroy.

Changes to Outputs:
  + web_ip  = (known after apply)
  + api_ip  = (known after apply)
`.trim();

// ── AWS CLI ────────────────────────────────────────────────
const awsEc2Describe = JSON.stringify({
  Reservations: Array.from({ length: 20 }, (_, i) => ({
    ReservationId: `r-${String(i).padStart(8, '0')}`,
    Instances: [{
      InstanceId: `i-${String(i).padStart(17, '0')}`,
      InstanceType: ["t3.micro", "t3.small", "t3.medium", "m5.large"][i % 4],
      State: { Code: i < 15 ? 16 : 80, Name: i < 15 ? "running" : "stopped" },
      PrivateIpAddress: `10.0.${Math.floor(i/256)}.${i % 256}`,
      PublicIpAddress: i < 10 ? `54.${i}.${i}.${i}` : null,
      Tags: [{ Key: "Name", Value: `server-${i}` }, { Key: "Environment", Value: i < 10 ? "prod" : "staging" }],
      LaunchTime: `2024-0${(i % 9) + 1}-15T10:00:00Z`,
      SecurityGroups: [{ GroupId: `sg-${i}`, GroupName: `sg-${i}` }],
      SubnetId: `subnet-${i % 3}`,
      VpcId: "vpc-abc123",
      Architecture: "x86_64",
      RootDeviceType: "ebs",
      BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: `vol-${i}`, Status: "attached" } }],
    }]
  }))
}, null, 2);

// ── Gradle build ───────────────────────────────────────────
const gradleBuild = Array.from({ length: 80 }, (_, i) => {
  const tasks = ["compileJava", "compileKotlin", "processResources", "classes", "jar", "test", "check", "build"];
  const modules = ["app", "core", "api", "data", "auth", "common", "ui", "service"];
  const mod = modules[i % 8];
  const task = tasks[i % 8];
  return `> Task :${mod}:${task}`;
}).join("\n") + `\n\nBUILD SUCCESSFUL in 45s\n80 actionable tasks: 65 executed, 15 up-to-date`;

// ── Maven build ────────────────────────────────────────────
const mavenBuild = [
  "[INFO] Scanning for projects...",
  "[INFO] ------------------------------------------------------------------------",
  "[INFO] Reactor Build Order:",
  "[INFO] ",
  ...Array.from({ length: 12 }, (_, i) => `[INFO]   ${["parent", "core", "api", "data", "auth", "web", "service", "common", "utils", "config", "test-support", "integration-tests"][i]}`),
  "[INFO] ",
  ...Array.from({ length: 12 }, (_, i) => {
    const mod = ["parent", "core", "api", "data", "auth", "web", "service", "common", "utils", "config", "test-support", "integration-tests"][i];
    return [
      `[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ ${mod} ---`,
      `[INFO] Changes detected - recompiling the module!`,
      `[INFO] Compiling ${10 + i * 5} source files to /target/classes`,
      `[INFO] --- maven-resources-plugin:3.3.1:resources (default-resources) @ ${mod} ---`,
      `[INFO] Copying ${3 + i} resource files`,
      `[INFO] --- maven-surefire-plugin:3.1.2:test (default-test) @ ${mod} ---`,
      `[INFO] Tests run: ${20 + i * 3}, Failures: 0, Errors: 0, Skipped: ${i % 3}`,
      `[INFO] `,
    ].join("\n");
  }),
  "[INFO] ------------------------------------------------------------------------",
  "[INFO] Reactor Summary:",
  "[INFO] ",
  ...Array.from({ length: 12 }, (_, i) => {
    const mod = ["parent", "core", "api", "data", "auth", "web", "service", "common", "utils", "config", "test-support", "integration-tests"][i];
    return `[INFO]   ${mod} .................................... SUCCESS [${2 + i}s]`;
  }),
  "[INFO] ------------------------------------------------------------------------",
  "[INFO] BUILD SUCCESS",
  "[INFO] Total time: 2:15 min",
].join("\n");

// ── Helm ───────────────────────────────────────────────────
const helmStatus = `NAME: my-release
LAST DEPLOYED: Mon Jan 15 10:00:00 2024
NAMESPACE: production
STATUS: deployed
REVISION: 23

RESOURCES:
==> v1/ConfigMap
NAME                    DATA   AGE
${Array.from({ length: 8 }, (_, i) => `app-config-${i}            3      ${i + 1}d`).join("\n")}

==> v1/Secret
NAME                    TYPE     DATA   AGE
${Array.from({ length: 5 }, (_, i) => `app-secret-${i}            Opaque   ${2 + i}      ${i + 1}d`).join("\n")}

==> v1/Service
NAME                    TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)          AGE
${Array.from({ length: 6 }, (_, i) => `svc-${i}                    ${i < 2 ? "LoadBalancer" : "ClusterIP   "}   10.0.${i}.${i}       ${i < 2 ? `34.${i}.${i}.${i}` : "<none>      "}     ${8080 + i}:${30000 + i}/TCP   ${i + 1}d`).join("\n")}

==> apps/v1/Deployment
NAME                    READY   UP-TO-DATE   AVAILABLE   AGE
${Array.from({ length: 10 }, (_, i) => `deploy-${i}                ${i < 8 ? `${3}/${3}` : `${1}/${3}`}     3            ${i < 8 ? 3 : 1}           ${i + 1}d`).join("\n")}

==> v1/Pod
NAME                              READY   STATUS    RESTARTS   AGE
${Array.from({ length: 30 }, (_, i) => `deploy-${i % 10}-${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + (i * 7) % 26)}${String.fromCharCode(97 + (i * 3) % 26)}-abc${i}   ${i < 25 ? "1/1" : "0/1"}     ${i < 25 ? "Running" : i < 28 ? "CrashLoopBackOff" : "Pending"}   ${i < 25 ? 0 : i - 24}          ${Math.floor(i / 3)}d`).join("\n")}

==> autoscaling/v2/HorizontalPodAutoscaler
NAME          REFERENCE          TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
${Array.from({ length: 4 }, (_, i) => `hpa-${i}         Deployment/deploy-${i}   ${20 + i * 10}%/80%   2         10        3          ${i + 1}d`).join("\n")}

NOTES:
Application deployed successfully.
Access via: https://app.example.com
Dashboard: https://dashboard.example.com`;

// ── Ansible ────────────────────────────────────────────────
const ansiblePlaybook = Array.from({ length: 40 }, (_, i) => {
  const hosts = ["web-01", "web-02", "web-03", "db-01", "db-02", "cache-01", "worker-01", "worker-02"];
  const tasks = ["Gathering Facts", "Install packages", "Configure nginx", "Deploy application", "Restart services"];
  const host = hosts[i % 8];
  const task = tasks[i % 5];
  const status = i < 35 ? "ok" : i < 38 ? "changed" : "failed";
  return `${status}: [${host}] => (item=${task})`;
}).join("\n") + `\n\nPLAY RECAP *********************************************************************
${["web-01", "web-02", "web-03", "db-01", "db-02", "cache-01", "worker-01", "worker-02"].map((h, i) =>
  `${h.padEnd(20)} : ok=${8 + i}   changed=${i % 3}    unreachable=0    failed=${i > 6 ? 1 : 0}   skipped=${i % 2}   rescued=0    ignored=0`
).join("\n")}`;

// ── xcodebuild ─────────────────────────────────────────────
const xcodebuild = [
  "Build settings from command line:",
  "    SDKROOT = iphoneos17.0",
  "",
  "=== BUILD TARGET MyApp OF PROJECT MyApp WITH CONFIGURATION Release ===",
  "",
  ...Array.from({ length: 60 }, (_, i) => {
    const files = ["AppDelegate", "ViewController", "DataManager", "NetworkClient", "AuthService", "ProfileView", "SettingsView", "CacheManager", "Logger", "Analytics"];
    const file = files[i % 10];
    const actions = ["CompileSwift", "CompileSwift", "CompileSwift", "CompileAssetCatalog", "Ld", "ProcessInfoPlistFile", "CompileStoryboard", "LinkStoryboards", "CompileSwift", "CodeSign"];
    const action = actions[i % 10];
    return `${action} normal arm64 ${file}.swift (in target 'MyApp' from project 'MyApp')
    cd /Users/dev/MyApp
    /usr/bin/swiftc -module-name MyApp -O -whole-module-optimization ${file}.swift`;
  }),
  "",
  "** BUILD SUCCEEDED **",
  "",
  "Build Timing Summary",
  "CompileSwift (50 tasks) | 12.345s",
  "Ld (1 task)             | 2.100s",
  "Total                   | 14.445s",
].join("\n");

// ── Nx affected ────────────────────────────────────────────
const nxAffected = [
  "",
  "   ✔  nx run shared-utils:build (1s)",
  "   ✔  nx run shared-ui:build (2s)",
  "   ✔  nx run data-access:build (1s)",
  "   ✔  nx run feature-auth:build (3s)",
  "   ✔  nx run feature-dashboard:build (4s)",
  ...Array.from({ length: 30 }, (_, i) =>
    `   ✔  nx run lib-${i}:build (${1 + (i % 5)}s)`
  ),
  "   ✔  nx run app-web:build (8s)",
  "   ✔  nx run app-mobile:build (6s)",
  "   ✔  nx run app-admin:build (5s)",
  "",
  "—————————————————————————————————————————————————————————————",
  "",
  " >  NX   Successfully ran target build for 38 projects (32s)",
  "",
  "   With additional flags:",
  "     --parallel=5",
  "",
].join("\n");

// ── Prisma migrate ─────────────────────────────────────────
const prismaMigrate = [
  "Prisma schema loaded from prisma/schema.prisma",
  "Datasource \"db\": PostgreSQL database \"myapp\", schema \"public\" at \"localhost:5432\"",
  "",
  "Applying migration `20240115_init`",
  "Applying migration `20240120_add_users`",
  "Applying migration `20240125_add_posts`",
  "Applying migration `20240130_add_comments`",
  "Applying migration `20240205_add_likes`",
  "Applying migration `20240210_add_notifications`",
  "Applying migration `20240215_add_settings`",
  "Applying migration `20240220_refactor_auth`",
  "",
  "The following migration(s) have been applied:",
  "",
  "migrations/",
  "  └─ 20240115_init/",
  "    └─ migration.sql",
  "  └─ 20240120_add_users/",
  "    └─ migration.sql",
  "  └─ 20240125_add_posts/",
  "    └─ migration.sql",
  "  └─ 20240130_add_comments/",
  "    └─ migration.sql",
  "  └─ 20240205_add_likes/",
  "    └─ migration.sql",
  "  └─ 20240210_add_notifications/",
  "    └─ migration.sql",
  "  └─ 20240215_add_settings/",
  "    └─ migration.sql",
  "  └─ 20240220_refactor_auth/",
  "    └─ migration.sql",
  "",
  "Your database is now in sync with your schema.",
  "",
  "✔ Generated Prisma Client (v5.8.0) to ./node_modules/@prisma/client in 234ms",
].join("\n");

// ── Playwright test ────────────────────────────────────────
const playwrightTest = [
  "Running 45 tests using 4 workers",
  "",
  ...Array.from({ length: 40 }, (_, i) =>
    `  ✓  ${i + 1} [chromium] › tests/e2e/test-${Math.floor(i / 5)}.spec.ts:${10 + (i % 5) * 20} › ${["login flow", "dashboard renders", "create item", "delete item", "search works"][i % 5]} (${200 + i * 50}ms)`
  ),
  `  ✘  41 [chromium] › tests/e2e/test-8.spec.ts:10 › checkout flow (5000ms)`,
  `     Error: Timed out waiting for element: data-testid="checkout-btn"`,
  `       at tests/e2e/test-8.spec.ts:15:20`,
  `  ✘  42 [firefox] › tests/e2e/test-8.spec.ts:30 › payment processing (3000ms)`,
  `     Error: Expected "success" but received "pending"`,
  `       at tests/e2e/test-8.spec.ts:35:10`,
  ...Array.from({ length: 3 }, (_, i) =>
    `  ✓  ${43 + i} [webkit] › tests/e2e/test-9.spec.ts:${10 + i * 10} › ${["settings page", "profile update", "logout"][i]} (${300 + i * 100}ms)`
  ),
  "",
  "  43 passed (2.5m)",
  "  2 failed",
  "",
  "  Slow tests:",
  "  [chromium] › tests/e2e/test-5.spec.ts:10 › create item (4.2s)",
  "  [firefox] › tests/e2e/test-3.spec.ts:30 › dashboard renders (3.8s)",
].join("\n");

// ── shellcheck ─────────────────────────────────────────────
const shellcheck = Array.from({ length: 25 }, (_, i) => {
  const codes = ["SC2086", "SC2046", "SC2034", "SC2155", "SC2164", "SC2006", "SC2035", "SC2012"];
  const code = codes[i % 8];
  const msgs: Record<string, string> = {
    SC2086: "Double quote to prevent globbing and word splitting.",
    SC2046: "Quote this to prevent word splitting.",
    SC2034: "foo appears unused. Verify use (or export).",
    SC2155: "Declare and assign separately to avoid masking return values.",
    SC2164: "Use 'cd ... || exit' in case cd fails.",
    SC2006: "Use $(...) notation instead of legacy backticks.",
    SC2035: "Use ./*glob* or -- glob so names with dashes won't become options.",
    SC2012: "Use find instead of ls to better handle non-alphanumeric filenames.",
  };
  return `In scripts/deploy.sh line ${10 + i * 5}:\n  ${["rm -rf $dir", "cd $path", "foo=bar", "local x=$(cmd)", "cd /tmp", "echo \`date\`", "ls *.log", "ls -l | wc"][i % 8]}\n  ${" ".repeat(i % 6)}^-- ${code} (${i < 5 ? "error" : i < 15 ? "warning" : "info"}): ${msgs[code]}\n`;
}).join("\n");

// ── Docker Compose ─────────────────────────────────────────
const dockerCompose = [
  "[+] Running 12/12",
  ...Array.from({ length: 12 }, (_, i) => {
    const services = ["postgres", "redis", "rabbitmq", "nginx", "api", "worker", "scheduler", "monitoring", "grafana", "prometheus", "elasticsearch", "kibana"];
    return ` ✔ Container myapp-${services[i]}-1  ${i < 10 ? "Started" : "Created"}    ${(0.5 + i * 0.3).toFixed(1)}s`;
  }),
  "",
  "Attaching to myapp-api-1, myapp-worker-1, myapp-scheduler-1",
  ...Array.from({ length: 50 }, (_, i) => {
    const services = ["api", "worker", "scheduler"];
    const svc = services[i % 3];
    return `myapp-${svc}-1  | 2024-01-15T10:${String(i).padStart(2, "0")}:00Z INFO  [${svc}] ${["Initializing", "Loading config", "Connecting to DB", "Ready", "Processing request"][i % 5]} (${10 + i}ms)`;
  }),
].join("\n");

// ── Make ───────────────────────────────────────────────────
const makeBuild = [
  ...Array.from({ length: 40 }, (_, i) => {
    const files = ["main", "utils", "config", "handler", "parser", "lexer", "codegen", "optimizer", "linker", "loader"];
    const file = files[i % 10];
    return `gcc -c -O2 -Wall -Wextra -I./include src/${file}${Math.floor(i / 10)}.c -o build/${file}${Math.floor(i / 10)}.o`;
  }),
  "gcc -o bin/myapp build/*.o -lpthread -lm -lssl -lcrypto",
  "strip bin/myapp",
  "make[1]: Leaving directory '/home/user/project'",
  "",
  "Build complete: bin/myapp (2.4 MB)",
].join("\n");

// ── kubectl describe pod ───────────────────────────────────
const kubectlDescribe = `Name:             api-deployment-7f8b9c6d5-abc12
Namespace:        production
Priority:         0
Service Account:  api-sa
Node:             ip-10-0-1-42.ec2.internal/10.0.1.42
Start Time:       Mon, 15 Jan 2024 10:00:00 +0000
Labels:           app=api
                  pod-template-hash=7f8b9c6d5
                  version=v2.3.1
Annotations:      kubernetes.io/psp: restricted
Status:           Running
IP:               10.0.1.100
Controlled By:    ReplicaSet/api-deployment-7f8b9c6d5
Containers:
  api:
    Container ID:   docker://abc123def456
    Image:          registry.example.com/api:v2.3.1
    Image ID:       docker-pullable://registry.example.com/api@sha256:abcdef123456
    Port:           8080/TCP
    Host Port:      0/TCP
    State:          Running
      Started:      Mon, 15 Jan 2024 10:00:05 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      cpu:     500m
      memory:  512Mi
    Requests:
      cpu:      250m
      memory:   256Mi
    Liveness:   http-get http://:8080/health delay=30s timeout=5s period=10s #success=1 #failure=3
    Readiness:  http-get http://:8080/ready delay=5s timeout=3s period=5s #success=1 #failure=3
    Environment:
      DATABASE_URL:   <set to the key 'database-url' in secret 'api-secrets'>
      REDIS_URL:      <set to the key 'redis-url' in secret 'api-secrets'>
      LOG_LEVEL:      info
      NODE_ENV:       production
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from api-sa-token (ro)
      /app/config from config-volume (ro)
Conditions:
  Type              Status
  Initialized       True
  Ready             True
  ContainersReady   True
  PodScheduled      True
Volumes:
  config-volume:
    Type:      ConfigMap (a volume populated by a ConfigMap)
    Name:      api-config
    Optional:  false
  api-sa-token:
    Type:                    Secret (a volume populated by a Secret)
    SecretName:              api-sa-token-xyz
    Optional:                false
QoS Class:                   Burstable
Node-Selectors:              node-role=app
Tolerations:                 node.kubernetes.io/not-ready:NoExecute for 300s
                             node.kubernetes.io/unreachable:NoExecute for 300s
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  5m    default-scheduler  Successfully assigned production/api-deployment-7f8b9c6d5-abc12 to ip-10-0-1-42
  Normal  Pulled     5m    kubelet            Container image "registry.example.com/api:v2.3.1" already present on machine
  Normal  Created    5m    kubelet            Created container api
  Normal  Started    5m    kubelet            Started container api`;

const cases: TestCase[] = [
  { label: "terraform plan (5 resources)", command: "terraform plan", output: terraformPlan },
  { label: "aws ec2 describe (20 instances)", command: "aws ec2 describe-instances", output: awsEc2Describe },
  { label: "gradle build (80 tasks)", command: "./gradlew build", output: gradleBuild },
  { label: "maven build (12 modules)", command: "mvn clean install", output: mavenBuild },
  { label: "helm status (30 pods)", command: "helm status my-release", output: helmStatus },
  { label: "ansible playbook (40 tasks)", command: "ansible-playbook deploy.yml", output: ansiblePlaybook },
  { label: "xcodebuild (60 files)", command: "xcodebuild -scheme MyApp build", output: xcodebuild },
  { label: "nx affected build (38 projects)", command: "npx nx affected --target=build", output: nxAffected },
  { label: "prisma migrate", command: "npx prisma migrate deploy", output: prismaMigrate },
  { label: "playwright test (45 tests, 2 fail)", command: "npx playwright test", output: playwrightTest },
  { label: "shellcheck (25 findings)", command: "shellcheck scripts/deploy.sh", output: shellcheck },
  { label: "docker compose up (12 services)", command: "docker compose up", output: dockerCompose },
  { label: "make build (40 files)", command: "make -j8", output: makeBuild },
  { label: "kubectl describe pod", command: "kubectl describe pod api-deployment-7f8b9c6d5-abc12", output: kubectlDescribe },
];

async function run() {
  process.stderr.write("Testing pipeline against RTK-covered tools we lack dedicated filters for...\n\n");

  const results: { label: string; strategy: string; conf: number; hint: string; inChars: number; outChars: number; pct: number }[] = [];

  for (const tc of cases) {
    const { text, classification } = await compressShellOutput(tc.command, tc.output);
    const inC = tc.output.length;
    const outC = text.length;
    const pct = inC > 0 ? ((1 - outC / inC) * 100) : 0;

    results.push({
      label: tc.label,
      strategy: classification.category,
      conf: classification.confidence,
      hint: classification.hint_source ?? "none",
      inChars: inC,
      outChars: outC,
      pct: Math.max(0, pct),
    });

    process.stderr.write(`─── ${tc.label} ───\n`);
    process.stderr.write(`  classified as: ${classification.category} (conf ${classification.confidence.toFixed(2)}, ${classification.hint_source})\n`);
    process.stderr.write(`  ${inC.toLocaleString()} chars → ${outC.toLocaleString()} chars (${pct.toFixed(1)}% saved)\n`);
    // Show first 5 lines of compressed output
    const preview = text.split("\n").slice(0, 8).join("\n");
    process.stderr.write(`  preview:\n    ${preview.split("\n").join("\n    ")}\n\n`);
  }

  process.stderr.write("\n═══ SUMMARY: RTK-covered tools through our pipeline ═══\n\n");
  process.stderr.write(`${"Label".padEnd(45)} ${"Strategy".padEnd(20)} ${"Conf".padEnd(6)} ${"In".padEnd(10)} ${"Out".padEnd(10)} Saved\n`);
  process.stderr.write("─".repeat(105) + "\n");
  for (const r of results) {
    process.stderr.write(
      `${r.label.padEnd(45)} ${r.strategy.padEnd(20)} ${r.conf.toFixed(2).padEnd(6)} ${r.inChars.toLocaleString().padEnd(10)} ${r.outChars.toLocaleString().padEnd(10)} ${r.pct.toFixed(1)}%\n`
    );
  }

  const totalIn = results.reduce((s, r) => s + r.inChars, 0);
  const totalOut = results.reduce((s, r) => s + r.outChars, 0);
  const totalPct = ((1 - totalOut / totalIn) * 100).toFixed(1);
  const avgPct = (results.reduce((s, r) => s + r.pct, 0) / results.length).toFixed(1);

  process.stderr.write("─".repeat(105) + "\n");
  process.stderr.write(`${"TOTAL".padEnd(45)} ${"".padEnd(20)} ${"".padEnd(6)} ${totalIn.toLocaleString().padEnd(10)} ${totalOut.toLocaleString().padEnd(10)} ${totalPct}%\n`);
  process.stderr.write(`\nAverage per-case compression: ${avgPct}%\n`);

  // Count how many fell to omni vs strategy
  const omniCount = results.filter(r => r.conf < 0.7).length;
  const strategyCount = results.length - omniCount;
  process.stderr.write(`\nRouting: ${strategyCount}/${results.length} hit strategy-specific compressors, ${omniCount}/${results.length} fell to omni\n`);
}

run().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
