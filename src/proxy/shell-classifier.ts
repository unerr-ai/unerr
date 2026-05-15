/**
 * Layer 6 Sprint FE-D — two-phase shell stdout classifier (command hint + content heuristics).
 */

export type OutputCategory =
  | "tabular"
  | "structured"
  | "log_text"
  | "diff"
  | "tree_paths"
  | "key_value"
  | "error_diagnostic"
  | "test_results"
  | "progress_streaming"
  | "yaml";

export type HintSource = "command_name" | "content_heuristic" | "both";

export interface ClassifyResult {
  category: OutputCategory;
  confidence: number;
  hint_source: HintSource;
}

/** Normalized substring → category (longest match wins in lookup). */
export const COMMAND_HINTS: Record<string, OutputCategory> = {
  // ═══════════════════════════════════════════════════════════════
  // ── TABULAR ──
  // ═══════════════════════════════════════════════════════════════
  "docker ps": "tabular",
  "docker images": "tabular",
  "docker stats": "tabular",
  "docker volume ls": "tabular",
  "docker network ls": "tabular",
  "docker system df": "tabular",
  "docker history": "tabular",
  "docker top": "tabular",
  "podman ps": "tabular",
  "podman images": "tabular",
  "df -h": "tabular",
  "df -l": "tabular",
  df: "tabular",
  "ls -l": "tabular",
  "ls -la": "tabular",
  "ls -lah": "tabular",
  "ls -lh": "tabular",
  ls: "tabular",
  ps: "tabular",
  du: "tabular",
  wc: "tabular",
  "kubectl get": "tabular",
  "kubectl top": "tabular",
  "kubectl top pods": "tabular",
  "kubectl top nodes": "tabular",
  "kubectl get events": "tabular",
  "kubectl config get-contexts": "tabular",
  "kubectl api-resources": "tabular",
  "helm list": "tabular",
  "helm ls": "tabular",
  "helm history": "tabular",
  "helm search": "tabular",
  "helm repo list": "tabular",
  lsof: "tabular",
  netstat: "tabular",
  "netstat -tlnp": "tabular",
  ss: "tabular",
  "ss -tlnp": "tabular",
  top: "tabular",
  htop: "tabular",
  free: "tabular",
  "free -h": "tabular",
  vmstat: "tabular",
  iostat: "tabular",
  mpstat: "tabular",
  sar: "tabular",
  lsmem: "tabular",
  who: "tabular",
  w: "tabular",
  last: "tabular",
  lastlog: "tabular",
  lspci: "tabular",
  lsusb: "tabular",
  "lshw -short": "tabular",
  lsblk: "tabular",
  "fdisk -l": "tabular",
  findmnt: "tabular",
  lsmod: "tabular",
  "dpkg -l": "tabular",
  "zypper search": "tabular",
  "snap list": "tabular",
  "flatpak list": "tabular",
  "brew services list": "tabular",
  "ip route": "tabular",
  "ip neigh": "tabular",
  route: "tabular",
  arp: "tabular",
  "mtr --report": "tabular",
  mtr: "tabular",
  tshark: "tabular",
  "iptables -L": "tabular",
  "perf report": "tabular",
  "perf top": "tabular",
  "py-spy": "tabular",
  pmap: "tabular",
  nm: "tabular",
  pgrep: "log_text",
  "pm2 list": "tabular",
  "pm2 status": "tabular",
  "forever list": "tabular",
  "git shortlog": "log_text",
  "git blame": "log_text",
  "git annotate": "log_text",
  "git worktree list": "tabular",
  "gh run list": "tabular",
  "gh pr list": "tabular",
  "gh pr checks": "tabular",
  "gh issue list": "tabular",
  "gh workflow list": "tabular",
  "gh release list": "tabular",
  "gh search": "tabular",
  "act -l": "tabular",
  "systemctl list-units": "tabular",
  "launchctl list": "tabular",
  "aws s3 ls": "tabular",
  "gcloud compute instances list": "tabular",
  "gcloud projects list": "tabular",
  "gcloud services list": "tabular",
  "vercel ls": "tabular",
  "heroku ps": "tabular",
  "multipass list": "tabular",
  psql: "tabular",
  mysql: "tabular",
  sqlite3: "tabular",
  pgcli: "tabular",
  mycli: "tabular",
  litecli: "tabular",
  vegeta: "tabular",
  bandwhich: "tabular",
  iftop: "tabular",
  nethogs: "tabular",
  ncdu: "tabular",
  "btrfs subvolume list": "tabular",
  "zfs list": "tabular",

  // ═══════════════════════════════════════════════════════════════
  // ── DIFF ──
  // ═══════════════════════════════════════════════════════════════
  "git diff": "diff",
  "git show": "diff",
  diff: "diff",
  "git format-patch": "diff",
  "gh pr diff": "diff",
  "cdk diff": "diff",
  "autopep8 --diff": "diff",
  "yapf --diff": "diff",
  "shfmt -d": "diff",

  // ═══════════════════════════════════════════════════════════════
  // ── LOG / BUILD OUTPUT ──
  // ═══════════════════════════════════════════════════════════════
  tail: "log_text",
  journalctl: "log_text",
  "journalctl -u": "log_text",
  "journalctl -f": "log_text",
  less: "log_text",
  cat: "log_text",
  grep: "log_text",
  rg: "log_text",
  ag: "log_text",
  "docker logs": "log_text",
  "docker-compose up": "log_text",
  "docker-compose logs": "log_text",
  "docker compose up": "log_text",
  "docker compose logs": "log_text",
  "docker compose build": "log_text",
  "docker compose down": "log_text",
  "docker compose restart": "log_text",
  "docker compose exec": "log_text",
  "docker build": "log_text",
  "docker run": "log_text",
  "docker exec": "log_text",
  "docker system prune": "log_text",
  "podman build": "log_text",
  "podman run": "log_text",
  "podman logs": "log_text",
  dmesg: "log_text",
  "git log": "log_text",
  "git log --oneline": "log_text",
  "git log --stat": "log_text",
  "git log --graph": "log_text",
  "git stash": "log_text",
  "git bisect": "log_text",
  "git reflog": "log_text",
  "git cherry-pick": "log_text",
  "git rebase": "log_text",
  "git merge": "log_text",
  make: "log_text",
  cmake: "log_text",
  ninja: "log_text",
  // JS/TS build
  webpack: "log_text",
  "vite build": "log_text",
  "vite preview": "log_text",
  "pnpm run build": "log_text",
  "npm run build": "log_text",
  "yarn build": "log_text",
  rollup: "log_text",
  esbuild: "log_text",
  swc: "log_text",
  tsup: "log_text",
  "tsc --build": "log_text",
  unbuild: "log_text",
  "parcel build": "log_text",
  // Monorepo / meta-build
  "nx build": "log_text",
  "nx run-many --target=build": "log_text",
  "nx run-many": "log_text",
  "nx run": "log_text",
  "npx nx": "log_text",
  "turbo build": "log_text",
  "turbo run build": "log_text",
  "turbo run": "log_text",
  "npx turbo": "log_text",
  "bazel build": "log_text",
  "bazel run": "log_text",
  "lerna run": "log_text",
  "lerna build": "log_text",
  "rush build": "log_text",
  "rush rebuild": "log_text",
  "moon run": "log_text",
  "moon check": "log_text",
  // Frameworks
  "next build": "log_text",
  "next dev": "log_text",
  "nuxt build": "log_text",
  "nuxt dev": "log_text",
  "gatsby build": "log_text",
  "astro build": "log_text",
  "remix build": "log_text",
  "svelte-kit build": "log_text",
  "ng build": "log_text",
  "ng serve": "log_text",
  "ember build": "log_text",
  "expo build": "log_text",
  "react-native run-android": "log_text",
  "react-native run-ios": "log_text",
  "flutter build": "log_text",
  "flutter run": "log_text",
  "dart compile": "log_text",
  // Rust build
  "cargo build": "log_text",
  "cargo run": "log_text",
  "cargo check": "error_diagnostic",
  // Go build
  "go build": "log_text",
  "go run": "log_text",
  "go generate": "log_text",
  // Java/JVM build
  "gradle build": "log_text",
  "./gradlew build": "log_text",
  "./gradlew": "log_text",
  "mvn compile": "log_text",
  "mvn package": "log_text",
  "mvn install": "log_text",
  mvn: "log_text",
  gradle: "log_text",
  sbt: "log_text",
  // Swift
  xcodebuild: "log_text",
  // .NET
  "dotnet run": "log_text",
  "dotnet publish": "log_text",
  // Ruby
  rake: "log_text",
  // Other languages
  "zig build": "log_text",
  "deno compile": "log_text",
  "bun build": "log_text",
  meson: "log_text",
  "meson compile": "log_text",
  "meson setup": "log_text",
  "cabal build": "log_text",
  "stack build": "log_text",
  "mix compile": "log_text",
  "rebar3 compile": "log_text",
  "shards build": "log_text",
  "nimble build": "log_text",
  "opam build": "log_text",
  "dune build": "log_text",
  "nix build": "log_text",
  "wasm-pack build": "log_text",
  emcc: "log_text",
  protoc: "log_text",
  "buf build": "log_text",
  "graphql-codegen": "log_text",
  "openapi-generator": "log_text",
  // Cloud / deploy
  "ansible-playbook": "log_text",
  ansible: "log_text",
  "kubectl apply": "log_text",
  "kubectl delete": "log_text",
  "kubectl create": "log_text",
  "kubectl patch": "log_text",
  "kubectl rollout": "log_text",
  "kubectl scale": "log_text",
  "kubectl exec": "log_text",
  "kubectl port-forward": "log_text",
  "kubectl logs": "log_text",
  "helm install": "log_text",
  "helm upgrade": "log_text",
  "helm uninstall": "log_text",
  "helm rollback": "log_text",
  "terraform apply": "log_text",
  "terraform destroy": "log_text",
  "terraform plan": "log_text",
  "terraform fmt": "log_text",
  "terraform import": "log_text",
  "terraform refresh": "log_text",
  "pulumi up": "log_text",
  "pulumi preview": "log_text",
  "pulumi destroy": "log_text",
  "cdk deploy": "log_text",
  "cdk destroy": "log_text",
  "serverless deploy": "log_text",
  "sls deploy": "log_text",
  "sam build": "log_text",
  "sam deploy": "log_text",
  "sam local start-api": "log_text",
  "aws logs": "log_text",
  "gcloud run deploy": "log_text",
  "gcloud builds submit": "log_text",
  "az webapp deploy": "log_text",
  "fly deploy": "log_text",
  "fly logs": "log_text",
  "vercel deploy": "log_text",
  "netlify deploy": "log_text",
  "heroku logs": "log_text",
  "railway deploy": "log_text",
  "railway logs": "log_text",
  "supabase db push": "log_text",
  "supabase functions deploy": "log_text",
  "wrangler deploy": "log_text",
  "wrangler dev": "log_text",
  "wrangler tail": "log_text",
  "firebase deploy": "log_text",
  "firebase serve": "log_text",
  "firebase functions:log": "log_text",
  "firebase emulators:start": "log_text",
  "vagrant up": "log_text",
  "vagrant halt": "log_text",
  "vagrant destroy": "log_text",
  "minikube start": "log_text",
  "kind create cluster": "log_text",
  "skaffold dev": "log_text",
  "skaffold build": "log_text",
  "skaffold deploy": "log_text",
  "tilt up": "log_text",
  // Database migrations
  "prisma migrate": "log_text",
  "prisma db push": "log_text",
  "prisma generate": "log_text",
  "npx prisma": "log_text",
  "sequelize db:migrate": "log_text",
  "typeorm migration:run": "log_text",
  "knex migrate:latest": "log_text",
  "drizzle-kit push": "log_text",
  "drizzle-kit generate": "log_text",
  "flyway migrate": "log_text",
  "liquibase update": "log_text",
  "alembic upgrade": "log_text",
  "diesel migration run": "log_text",
  "goose up": "log_text",
  "atlas migrate apply": "log_text",
  "dbmate up": "log_text",
  "sqitch deploy": "log_text",
  pg_dump: "log_text",
  pg_restore: "log_text",
  mysqldump: "log_text",
  // CI/CD
  "gh run watch": "log_text",
  act: "log_text",
  "gitlab-runner exec": "log_text",
  "circleci local execute": "log_text",
  "gh copilot": "log_text",
  // Debugging / profiling
  strace: "log_text",
  ltrace: "log_text",
  dtrace: "log_text",
  valgrind: "log_text",
  "valgrind --tool=memcheck": "log_text",
  "valgrind --tool=callgrind": "log_text",
  heaptrack: "log_text",
  gdb: "log_text",
  lldb: "log_text",
  pprof: "log_text",
  "go tool pprof": "log_text",
  objdump: "log_text",
  strings: "log_text",
  "node --inspect": "log_text",
  nodemon: "log_text",
  "pm2 logs": "log_text",
  concurrently: "log_text",
  // Networking
  ping: "log_text",
  ping6: "log_text",
  traceroute: "log_text",
  tracepath: "log_text",
  "curl -v": "log_text",
  nc: "log_text",
  ncat: "log_text",
  socat: "log_text",
  telnet: "log_text",
  "ssh -v": "log_text",
  tcpdump: "log_text",
  // Doc generators
  typedoc: "log_text",
  jsdoc: "log_text",
  doxygen: "log_text",
  "sphinx-build": "log_text",
  "mkdocs build": "log_text",
  "mkdocs serve": "log_text",
  "mdbook build": "log_text",
  rustdoc: "log_text",
  // Misc
  "systemctl start": "log_text",
  "systemctl stop": "log_text",
  "systemctl restart": "log_text",
  "systemctl enable": "log_text",
  "systemctl disable": "log_text",
  watch: "log_text",
  xargs: "log_text",
  parallel: "log_text",
  task: "log_text",
  just: "log_text",
  earthly: "log_text",
  pants: "log_text",
  "please build": "log_text",
  "buck2 build": "log_text",
  "python -c": "log_text",
  "python3 -c": "log_text",

  // ═══════════════════════════════════════════════════════════════
  // ── TEST RESULTS ──
  // ═══════════════════════════════════════════════════════════════
  "npm test": "test_results",
  "npm run test": "test_results",
  "pnpm test": "test_results",
  "pnpm run test": "test_results",
  "yarn test": "test_results",
  vitest: "test_results",
  jest: "test_results",
  mocha: "test_results",
  pytest: "test_results",
  "python -m pytest": "test_results",
  "python3 -m pytest": "test_results",
  "cargo test": "test_results",
  "go test": "test_results",
  rspec: "test_results",
  "bundle exec rspec": "test_results",
  phpunit: "test_results",
  "dotnet test": "test_results",
  "swift test": "test_results",
  "gradle test": "test_results",
  "./gradlew test": "test_results",
  "gradle check": "test_results",
  "./gradlew check": "test_results",
  "mvn test": "test_results",
  "mvn verify": "test_results",
  "sbt test": "test_results",
  "sbt it:test": "test_results",
  minitest: "test_results",
  "mix test": "test_results",
  "playwright test": "test_results",
  "npx playwright test": "test_results",
  "npx playwright": "test_results",
  "nx test": "test_results",
  "nx run-many --target=test": "test_results",
  "turbo test": "test_results",
  "turbo run test": "test_results",
  "bazel test": "test_results",
  ctest: "test_results",
  "zig test": "test_results",
  "deno test": "test_results",
  "bun test": "test_results",
  "bun run test": "test_results",
  "cypress run": "test_results",
  "npx cypress run": "test_results",
  wdio: "test_results",
  "npx wdio": "test_results",
  ava: "test_results",
  tap: "test_results",
  jasmine: "test_results",
  "karma start": "test_results",
  "elm-test": "test_results",
  "flutter test": "test_results",
  "dart test": "test_results",
  "crystal spec": "test_results",
  "helm test": "test_results",
  "container-structure-test": "test_results",
  "k6 run": "test_results",
  "artillery run": "test_results",
  "newman run": "test_results",
  hurl: "test_results",

  // ═══════════════════════════════════════════════════════════════
  // ── PROGRESS / INSTALL ──
  // ═══════════════════════════════════════════════════════════════
  "npm install": "progress_streaming",
  "npm i": "progress_streaming",
  "npm ci": "progress_streaming",
  "npm update": "progress_streaming",
  "pnpm install": "progress_streaming",
  "pnpm add": "progress_streaming",
  "pnpm i": "progress_streaming",
  "pnpm update": "progress_streaming",
  "pip install": "progress_streaming",
  "pip3 install": "progress_streaming",
  "uv pip install": "progress_streaming",
  "uv sync": "progress_streaming",
  "uv add": "progress_streaming",
  "yarn install": "progress_streaming",
  "yarn add": "progress_streaming",
  "yarn upgrade": "progress_streaming",
  "poetry install": "progress_streaming",
  "poetry add": "progress_streaming",
  "pipenv install": "progress_streaming",
  "bundle install": "progress_streaming",
  "gem install": "progress_streaming",
  "cargo install": "progress_streaming",
  "cargo add": "progress_streaming",
  "go install": "progress_streaming",
  "go get": "progress_streaming",
  "go mod download": "progress_streaming",
  "composer install": "progress_streaming",
  "composer update": "progress_streaming",
  "composer require": "progress_streaming",
  "deno install": "progress_streaming",
  "deno add": "progress_streaming",
  "bun install": "progress_streaming",
  "bun add": "progress_streaming",
  "pdm install": "progress_streaming",
  "pdm add": "progress_streaming",
  "conda install": "progress_streaming",
  "conda create": "progress_streaming",
  "conda update": "progress_streaming",
  "mamba install": "progress_streaming",
  "mamba create": "progress_streaming",
  "rye sync": "progress_streaming",
  "rye add": "progress_streaming",
  "mix deps.get": "progress_streaming",
  "pub get": "progress_streaming",
  "flutter pub get": "progress_streaming",
  "nuget restore": "progress_streaming",
  "dotnet restore": "progress_streaming",
  "vcpkg install": "progress_streaming",
  "conan install": "progress_streaming",
  wget: "progress_streaming",
  "apt install": "progress_streaming",
  "apt-get install": "progress_streaming",
  "apt update": "progress_streaming",
  "apt-get update": "progress_streaming",
  "brew install": "progress_streaming",
  "brew upgrade": "progress_streaming",
  "brew update": "progress_streaming",
  "dnf install": "progress_streaming",
  "yum install": "progress_streaming",
  "pacman -S": "progress_streaming",
  "snap install": "progress_streaming",
  "flatpak install": "progress_streaming",
  "nix-env -i": "progress_streaming",
  "docker pull": "progress_streaming",
  "docker push": "progress_streaming",
  "docker compose pull": "progress_streaming",
  "docker compose push": "progress_streaming",
  "podman pull": "progress_streaming",
  "terraform init": "progress_streaming",
  "helm repo update": "progress_streaming",
  "ansible-galaxy": "progress_streaming",
  "git pull": "progress_streaming",
  "git push": "progress_streaming",
  "git fetch": "progress_streaming",
  "git clone": "progress_streaming",
  "git submodule update": "progress_streaming",
  "git lfs pull": "progress_streaming",
  "git lfs push": "progress_streaming",
  "gh workflow run": "progress_streaming",
  "aws s3 cp": "progress_streaming",
  "aws s3 sync": "progress_streaming",
  "nvm install": "progress_streaming",
  "fnm install": "progress_streaming",
  "pyenv install": "progress_streaming",
  "rbenv install": "progress_streaming",
  "rustup update": "progress_streaming",
  "volta install": "progress_streaming",
  "asdf install": "progress_streaming",
  "mise install": "progress_streaming",
  "sdk install": "progress_streaming",
  "spack install": "progress_streaming",

  // ═══════════════════════════════════════════════════════════════
  // ── TREE / PATHS ──
  // ═══════════════════════════════════════════════════════════════
  tree: "tree_paths",
  find: "tree_paths",
  fd: "tree_paths",
  locate: "tree_paths",
  "ls -R": "tree_paths",
  "git ls-files": "tree_paths",
  "git ls-tree": "tree_paths",
  "dpkg -L": "tree_paths",
  "rpm -ql": "tree_paths",
  "pacman -Ql": "tree_paths",
  "brew deps": "tree_paths",

  // ═══════════════════════════════════════════════════════════════
  // ── STRUCTURED (JSON/YAML) ──
  // ═══════════════════════════════════════════════════════════════
  "docker inspect": "structured",
  "docker volume inspect": "structured",
  "docker network inspect": "structured",
  "podman inspect": "structured",
  "kubectl get -o json": "structured",
  "kubectl get -o yaml": "yaml",
  "kubectl get pods -o json": "structured",
  curl: "structured",
  "helm get": "yaml",
  "helm template": "yaml",
  "helm show": "yaml",
  "helm show values": "yaml",
  "terraform show": "structured",
  "terraform graph": "structured",
  "cdk synth": "structured",
  "serverless invoke": "structured",
  "sam local invoke": "structured",
  aws: "structured",
  "aws ec2 describe-instances": "structured",
  "aws ecs list-tasks": "structured",
  "aws lambda invoke": "structured",
  "aws cloudformation describe-stacks": "structured",
  "aws iam list-users": "structured",
  "aws sts get-caller-identity": "structured",
  "az vm list": "structured",
  "az group list": "structured",
  "az account show": "structured",
  "az aks": "structured",
  gcloud: "structured",
  jq: "structured",
  yq: "yaml",
  mongosh: "structured",
  mongo: "structured",
  "gh run view": "structured",
  "gh pr view": "structured",
  "gh issue view": "structured",
  "gh release view": "structured",
  "gh repo view": "structured",
  "gh api": "structured",
  grpcurl: "structured",
  httpie: "structured",
  http: "structured",
  dig: "structured",

  // ═══════════════════════════════════════════════════════════════
  // ── YAML ──
  // ═══════════════════════════════════════════════════════════════
  "kubectl get pods -o yaml": "yaml",
  "kubectl get deployment -o yaml": "yaml",
  "kubectl get service -o yaml": "yaml",
  "kubectl get configmap -o yaml": "yaml",
  "kubectl get secret -o yaml": "yaml",
  "kubectl get ingress -o yaml": "yaml",
  "kubectl get node -o yaml": "yaml",
  "helm get values": "yaml",
  "helm get manifest": "yaml",
  "cat docker-compose.yml": "yaml",
  "cat docker-compose.yaml": "yaml",
  "cat compose.yml": "yaml",
  "cat compose.yaml": "yaml",

  // ═══════════════════════════════════════════════════════════════
  // ── KEY-VALUE ──
  // ═══════════════════════════════════════════════════════════════
  env: "key_value",
  printenv: "key_value",
  "set -o": "key_value",
  "git config": "key_value",
  "git status": "key_value",
  "git remote": "key_value",
  "git branch": "key_value",
  "git tag": "key_value",
  "git tag -l": "key_value",
  "git describe": "key_value",
  "git rev-parse": "key_value",
  "git stash list": "key_value",
  "cargo metadata": "key_value",
  "pip show": "key_value",
  "pip3 show": "key_value",
  "npm ls": "key_value",
  "pnpm ls": "key_value",
  "go env": "key_value",
  // kubectl describe is Key: Value format, NOT JSON
  "kubectl describe": "key_value",
  "kubectl config": "key_value",
  "kubectl config view": "key_value",
  "kubectl cluster-info": "key_value",
  "kubectl explain": "key_value",
  "kubectl auth can-i": "key_value",
  kubectl: "key_value",
  "helm status": "key_value",
  // Terraform
  "terraform output": "key_value",
  "terraform state list": "key_value",
  "terraform state show": "key_value",
  "terraform providers": "key_value",
  "terraform workspace list": "key_value",
  // Cloud
  "pulumi stack": "key_value",
  "pulumi config": "key_value",
  "cdk list": "key_value",
  "serverless info": "key_value",
  "gcloud auth": "key_value",
  "gcloud config list": "key_value",
  "az login": "key_value",
  "fly status": "key_value",
  "vercel env": "key_value",
  "netlify status": "key_value",
  "netlify env": "key_value",
  "heroku config": "key_value",
  "heroku info": "key_value",
  "railway status": "key_value",
  "supabase status": "key_value",
  "vagrant status": "key_value",
  "multipass info": "key_value",
  "minikube status": "key_value",
  "kind get clusters": "key_value",
  // Database
  "redis-cli": "key_value",
  "redis-cli info": "key_value",
  // System
  "systemctl status": "key_value",
  "systemctl show": "key_value",
  service: "key_value",
  "launchctl print": "key_value",
  "crontab -l": "key_value",
  stat: "key_value",
  file: "key_value",
  md5sum: "key_value",
  sha256sum: "key_value",
  shasum: "key_value",
  readlink: "key_value",
  realpath: "key_value",
  blkid: "key_value",
  mount: "key_value",
  "du -sh": "key_value",
  nproc: "key_value",
  lscpu: "key_value",
  "sysctl -a": "key_value",
  sysctl: "key_value",
  "ulimit -a": "key_value",
  id: "key_value",
  groups: "key_value",
  whoami: "key_value",
  lshw: "key_value",
  dmidecode: "key_value",
  inxi: "key_value",
  system_profiler: "key_value",
  "uname -a": "key_value",
  uname: "key_value",
  modinfo: "key_value",
  getfacl: "key_value",
  "apt show": "key_value",
  "dpkg -s": "key_value",
  "rpm -qi": "key_value",
  "snap info": "key_value",
  "brew info": "key_value",
  "brew list": "key_value",
  "port info": "key_value",
  "docker info": "key_value",
  "docker version": "key_value",
  "docker port": "key_value",
  "docker tag": "key_value",
  // Networking
  "ip addr": "key_value",
  "ip link": "key_value",
  "ip -s link": "key_value",
  ifconfig: "key_value",
  nslookup: "key_value",
  host: "key_value",
  whois: "key_value",
  "curl -I": "key_value",
  "curl -w": "key_value",
  "wget --spider": "key_value",
  "openssl s_client": "key_value",
  "openssl x509": "key_value",
  "ssh-keygen -l": "key_value",
  "ufw status": "key_value",
  "nft list": "key_value",
  "firewall-cmd --list-all": "key_value",
  "iptables -S": "key_value",
  nmap: "key_value",
  ab: "key_value",
  wrk: "key_value",
  hey: "key_value",
  siege: "key_value",
  // Version queries
  "python --version": "key_value",
  "python3 --version": "key_value",
  "node --version": "key_value",
  "node -v": "key_value",
  "npm --version": "key_value",
  "pnpm --version": "key_value",
  "yarn --version": "key_value",
  "deno --version": "key_value",
  "bun --version": "key_value",
  "rustc --version": "key_value",
  "cargo --version": "key_value",
  "go version": "key_value",
  "java -version": "key_value",
  "ruby --version": "key_value",
  "php --version": "key_value",
  "swift --version": "key_value",
  "dotnet --version": "key_value",
  "gcc --version": "key_value",
  "g++ --version": "key_value",
  "clang --version": "key_value",
  "cmake --version": "key_value",
  "make --version": "key_value",
  "flutter --version": "key_value",
  "dart --version": "key_value",
  "zig version": "key_value",
  "elixir --version": "key_value",
  // Version managers
  "nvm ls": "key_value",
  "nvm use": "key_value",
  "fnm ls": "key_value",
  "fnm use": "key_value",
  "pyenv versions": "key_value",
  "rbenv versions": "key_value",
  "rustup show": "key_value",
  "rustup target list": "key_value",
  "rustup component list": "key_value",
  "volta list": "key_value",
  "asdf list": "key_value",
  "asdf current": "key_value",
  "mise list": "key_value",
  "mise current": "key_value",
  "direnv allow": "key_value",
  "direnv status": "key_value",
  "module list": "key_value",
  "module avail": "key_value",
  // Profiling
  "perf stat": "key_value",
  ldd: "key_value",
  "otool -L": "key_value",
  readelf: "key_value",
  time: "key_value",
  uptime: "key_value",
  fuser: "key_value",
  // CI
  "gh pr status": "key_value",
  "gh issue status": "key_value",
  "zpool status": "key_value",

  // ═══════════════════════════════════════════════════════════════
  // ── ERROR DIAGNOSTIC ──
  // ═══════════════════════════════════════════════════════════════
  // JS/TS
  tsc: "error_diagnostic",
  "npx tsc": "error_diagnostic",
  "pnpm run typecheck": "error_diagnostic",
  "npm run typecheck": "error_diagnostic",
  "yarn typecheck": "error_diagnostic",
  "pnpm typecheck": "error_diagnostic",
  eslint: "error_diagnostic",
  "npx eslint": "error_diagnostic",
  "biome check": "error_diagnostic",
  "biome lint": "error_diagnostic",
  "biome format --check": "error_diagnostic",
  oxlint: "error_diagnostic",
  xo: "error_diagnostic",
  jshint: "error_diagnostic",
  "deno lint": "error_diagnostic",
  "bun lint": "error_diagnostic",
  "pnpm run lint": "error_diagnostic",
  "npm run lint": "error_diagnostic",
  "yarn lint": "error_diagnostic",
  "pnpm lint": "error_diagnostic",
  "pnpm run lint:fix": "error_diagnostic",
  "npm run lint:fix": "error_diagnostic",
  "yarn lint:fix": "error_diagnostic",
  "pnpm run check": "error_diagnostic",
  "npm run check": "error_diagnostic",
  "yarn check": "error_diagnostic",
  // Python
  mypy: "error_diagnostic",
  pyright: "error_diagnostic",
  ruff: "error_diagnostic",
  "ruff check": "error_diagnostic",
  flake8: "error_diagnostic",
  pylint: "error_diagnostic",
  bandit: "error_diagnostic",
  // Rust
  "cargo clippy": "error_diagnostic",
  rustc: "error_diagnostic",
  "cargo fmt --check": "error_diagnostic",
  "rustfmt --check": "error_diagnostic",
  // Go
  "go vet": "error_diagnostic",
  "golangci-lint": "error_diagnostic",
  "golangci-lint run": "error_diagnostic",
  staticcheck: "error_diagnostic",
  gosec: "error_diagnostic",
  "gofmt -l": "error_diagnostic",
  "goimports -l": "error_diagnostic",
  // Java/JVM
  javac: "error_diagnostic",
  kotlinc: "error_diagnostic",
  detekt: "error_diagnostic",
  ktlint: "error_diagnostic",
  scalastyle: "error_diagnostic",
  "scalafmt --check": "error_diagnostic",
  // C/C++
  gcc: "error_diagnostic",
  "g++": "error_diagnostic",
  clang: "error_diagnostic",
  "clang++": "error_diagnostic",
  cppcheck: "error_diagnostic",
  "clang-tidy": "error_diagnostic",
  "clang-format --dry-run": "error_diagnostic",
  // Swift
  swiftc: "error_diagnostic",
  "swift build": "error_diagnostic",
  swiftlint: "error_diagnostic",
  "swiftformat --lint": "error_diagnostic",
  // .NET
  "dotnet build": "error_diagnostic",
  // Ruby
  rubocop: "error_diagnostic",
  brakeman: "error_diagnostic",
  // PHP
  phpstan: "error_diagnostic",
  "php -l": "error_diagnostic",
  // Shell / config
  shellcheck: "error_diagnostic",
  hadolint: "error_diagnostic",
  "ansible-lint": "error_diagnostic",
  "terraform validate": "error_diagnostic",
  "helm lint": "error_diagnostic",
  yamllint: "error_diagnostic",
  jsonlint: "error_diagnostic",
  markdownlint: "error_diagnostic",
  stylelint: "error_diagnostic",
  vale: "error_diagnostic",
  actionlint: "error_diagnostic",
  commitlint: "error_diagnostic",
  tflint: "error_diagnostic",
  "kube-linter": "error_diagnostic",
  "polaris audit": "error_diagnostic",
  "buf lint": "error_diagnostic",
  "opa eval": "error_diagnostic",
  "conftest test": "error_diagnostic",
  checkov: "error_diagnostic",
  // Other languages
  "dart analyze": "error_diagnostic",
  "flutter analyze": "error_diagnostic",
  "elm-review": "error_diagnostic",
  dialyzer: "error_diagnostic",
  credo: "error_diagnostic",
  "mix credo": "error_diagnostic",
  ameba: "error_diagnostic",
  "nim check": "error_diagnostic",
  selene: "error_diagnostic",
  luacheck: "error_diagnostic",
  // Formatters (check mode)
  "prettier --check": "error_diagnostic",
  "black --check": "error_diagnostic",
  "isort --check": "error_diagnostic",
  "dprint check": "error_diagnostic",
  "taplo check": "error_diagnostic",
  "sql-formatter --check": "error_diagnostic",
  // Security scanners
  "npm audit": "error_diagnostic",
  "pnpm audit": "error_diagnostic",
  "yarn audit": "error_diagnostic",
  "cargo audit": "error_diagnostic",
  "pip-audit": "error_diagnostic",
  "safety check": "error_diagnostic",
  "snyk test": "error_diagnostic",
  "snyk code test": "error_diagnostic",
  "trivy image": "error_diagnostic",
  "trivy fs": "error_diagnostic",
  grype: "error_diagnostic",
  semgrep: "error_diagnostic",
  "semgrep scan": "error_diagnostic",
  "bearer scan": "error_diagnostic",
  "gitleaks detect": "error_diagnostic",
  trufflehog: "error_diagnostic",
  "detect-secrets scan": "error_diagnostic",
  "dependency-check": "error_diagnostic",
  retire: "error_diagnostic",
  "sonar-scanner": "error_diagnostic",
};

const CONFIDENCE_HINT = 0.82;
const CONFIDENCE_HEURISTIC = 0.74;
const CONFIDENCE_BOTH = 0.93;

export function normalizeShellCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Commands that don't produce meaningful stdout. When a chain has these as
 * the trailing segment, the actual stdout came from an earlier segment, so
 * we skip them when picking which segment's hint to use.
 *
 * Keys can be one-token (`chmod`) or two-token (`git add`). We check the
 * first one or two tokens of a segment against this set.
 */
const SILENT_COMMANDS = new Set([
  // POSIX filesystem mutations
  "chmod",
  "chown",
  "chgrp",
  "mkdir",
  "rmdir",
  "rm",
  "mv",
  "cp",
  "ln",
  "touch",
  // shell builtins / control
  "cd",
  "export",
  "set",
  "unset",
  "alias",
  "unalias",
  "umask",
  "true",
  "false",
  ":",
  // git mutators (most are silent on success)
  "git add",
  "git commit",
  "git push",
  "git pull",
  "git fetch",
  "git checkout",
  "git switch",
  "git stash",
  "git tag",
  "git rm",
  "git mv",
  "git reset",
  // pnpm/npm/yarn helpers
  "pnpm add",
  "pnpm remove",
  "npm install",
  "npm uninstall",
  "yarn add",
  "yarn remove",
]);

/** True if `seg` starts with a known silent (no-meaningful-stdout) command. */
function isSilentSegment(seg: string): boolean {
  const tokens = seg.trim().split(/\s+/);
  if (tokens.length === 0) return true;
  const one = tokens[0] ?? "";
  if (SILENT_COMMANDS.has(one)) return true;
  if (tokens.length >= 2) {
    const two = `${one} ${tokens[1]}`;
    if (SILENT_COMMANDS.has(two)) return true;
  }
  return false;
}

/** Strip `> file`, `>> file`, `2>&1`, `&` trailing background marker. */
function stripRedirects(seg: string): string {
  return seg
    .replace(/\s*\d?>>?\s*\S+/g, "")
    .replace(/\s*2>&1\s*/g, " ")
    .replace(/\s*&\s*$/g, "")
    .trim();
}

/** Pick the longest matching prefix in COMMAND_HINTS for a single segment. */
function matchPrefixHint(seg: string): {
  category: OutputCategory;
  key: string;
} | null {
  const s = stripRedirects(seg);
  let best: { category: OutputCategory; key: string; len: number } | null =
    null;
  for (const key of Object.keys(COMMAND_HINTS)) {
    if (s === key || s.startsWith(`${key} `)) {
      if (!best || key.length > best.len) {
        const cat = COMMAND_HINTS[key];
        if (!cat) continue;
        best = { category: cat, key, len: key.length };
      }
    }
  }
  return best ? { category: best.category, key: best.key } : null;
}

/**
 * Find the hint for the command whose stdout reaches the consumer. Splits the
 * normalized command on shell operators (`&&`, `||`, `;`, `|`) and walks the
 * resulting segments from last to first, preferring segments that aren't in
 * SILENT_COMMANDS (chmod, mkdir, git add, …). If every segment is silent we
 * fall back to a permissive last-to-first scan so single-segment commands
 * keep working unchanged.
 */
export function matchCommandHint(cmd: string): {
  category: OutputCategory;
  key: string;
} | null {
  const n = normalizeShellCommand(cmd);
  const segments = n
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) return null;

  // Pass 1 — prefer non-silent segments, scan last → first (the last meaningful
  // producer's stdout is what actually reaches the consumer of this chain).
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (isSilentSegment(seg)) continue;
    const hit = matchPrefixHint(seg);
    if (hit) return hit;
  }

  // Pass 2 — every segment is silent (or none had a hint). Scan again without
  // the silent filter so a single-segment `chmod +x foo` still gets the chance
  // to match a future `chmod` hint, and behaviour for non-chained commands is
  // exactly the same as before this refactor.
  for (let i = segments.length - 1; i >= 0; i--) {
    const hit = matchPrefixHint(segments[i]!);
    if (hit) return hit;
  }

  return null;
}

function scoreContent(lines: string[]): {
  category: OutputCategory;
  score: number;
} | null {
  const sample = lines.slice(0, 20).join("\n");
  let best: { category: OutputCategory; score: number } | null = null;

  const bump = (cat: OutputCategory, w: number) => {
    if (!best || w > best.score) best = { category: cat, score: w };
  };

  if (/^diff --git/m.test(sample) || /^@@ |^--- |\+\+\+ /m.test(sample)) {
    bump("diff", 0.9);
  }
  if (/^\s*[\[{]/.test(lines[0] ?? "") && /[}\]]\s*$/.test(sample.slice(-80))) {
    bump("structured", 0.72);
  }
  // YAML detection: lines starting with key: value, or --- document separator, with no JSON braces
  {
    const yamlDocSep = /^---\s*$/m.test(sample);
    const yamlKeyLines = lines.filter(
      (l) => /^\s*[\w][\w.-]*:\s/.test(l) && !/^\s*[\[{]/.test(l)
    ).length;
    const hasArrayItems = /^\s*-\s+\S/m.test(sample);
    const noJsonBraces = !/^\s*[\[{]/.test(lines[0] ?? "");
    if (yamlDocSep && yamlKeyLines >= 2) {
      bump("yaml", 0.82);
    } else if (
      noJsonBraces &&
      yamlKeyLines >= 4 &&
      (hasArrayItems || yamlDocSep)
    ) {
      bump("yaml", 0.78);
    }
  }
  if (
    /\d{4}-\d{2}-\d{2}T\d|\[\d{2}\/\w{3}\/\d{4}/.test(sample) ||
    /\d{2}:\d{2}:\d{2}\.\d{3}/.test(sample)
  ) {
    bump("log_text", 0.78);
  }
  // Build-like output: repeated similar lines, or mixed WARNING + build keywords
  {
    const hasWarn = /\bWARN(ING)?\b/i.test(sample);
    const hasBuildKeywords =
      /\b(compil|build|bundl|generat|transform|emit|output)/i.test(sample);
    if (hasWarn && hasBuildKeywords) {
      bump("log_text", 0.79);
    }
    // Detect repeated lines pattern (log/build output signature)
    const seen = new Map<string, number>();
    for (const line of lines.slice(0, 15)) {
      const norm = line.replace(/\d+/g, "N").trim();
      if (norm.length > 5) seen.set(norm, (seen.get(norm) ?? 0) + 1);
    }
    const repeats = [...seen.values()].filter((c) => c >= 3).length;
    if (repeats >= 1) bump("log_text", 0.75);
  }

  let aligned = 0;
  let inspectable = 0;
  for (const line of lines.slice(0, 15)) {
    if (line.length < 8) continue;
    inspectable++;
    if (/\s{2,}|\t/.test(line) && !line.startsWith(" ")) aligned++;
  }
  if (aligned >= 4) {
    bump("tabular", 0.8);
  } else if (
    aligned >= 3 &&
    inspectable <= 6 &&
    aligned / inspectable >= 0.75
  ) {
    // Short tabular outputs (eg `ls -la` of a handful of files, `docker ps`
    // with a single container): when most inspectable lines are aligned we
    // accept ≥3 rows. Lower confidence (0.72) so a disagreeing command hint
    // can still win, but still above the omni gate (0.7) so the strategy
    // fires rather than falling through to omni's flat dedup.
    bump("tabular", 0.72);
  }

  if (
    /\b(PASS|FAIL|✓|✗|✕|tests?\s+\d+\s+failed|AssertionError)/i.test(sample)
  ) {
    bump("test_results", 0.85);
  }
  if (
    /\b(Downloading|Installing|Building|packages?\s+\)|ETA|⠋|⠙|\[\s*\d+%\s*\])/.test(
      sample
    )
  ) {
    bump("progress_streaming", 0.82);
  }
  // tsc errors — very distinctive pattern
  if (/^.+\(\d+,\d+\): error TS\d{4}:/m.test(sample)) {
    bump("error_diagnostic", 0.95);
  }
  // ESLint — distinctive line:col  severity  message  rule format
  if (/^\s+\d+:\d+\s+(error|warning)\s+.+\s{2,}\S+/m.test(sample)) {
    bump("error_diagnostic", 0.92);
  }
  // gcc/clang: file.c:10:5: error: message
  if (
    /^.+:\d+:\d+:\s+(error|warning|note):/m.test(sample) &&
    !/error TS/.test(sample)
  ) {
    bump("error_diagnostic", 0.9);
  }
  // rustc: error[E0308]: ...
  if (/^error\[E\d{4}\]:/m.test(sample)) {
    bump("error_diagnostic", 0.94);
  }
  // Go diagnostics: file.go:10:5: message
  if (/^.+\.go:\d+:\d+:/m.test(sample)) {
    bump("error_diagnostic", 0.82);
  }
  // Python: mypy/pyright file.py:10: error: ...
  if (/^.+\.py:\d+:\s+(error|warning|note):/m.test(sample)) {
    bump("error_diagnostic", 0.9);
  }
  // Python: ruff/flake8 file.py:10:5: E501
  if (/^.+\.py:\d+:\d+:\s+[A-Z]\d+/m.test(sample)) {
    bump("error_diagnostic", 0.9);
  }
  // javac: File.java:10: error: ...
  if (/^.+\.java:\d+:\s+error:/m.test(sample)) {
    bump("error_diagnostic", 0.9);
  }
  // Python traceback
  if (/^Traceback \(most recent call last\):/m.test(sample)) {
    bump("error_diagnostic", 0.88);
  }
  // Only promote to error_diagnostic for strong error signals — not bare WARN/WARNING
  // which commonly appears in build output (deprecation warnings, etc.)
  if (/\bException\b|^\w+Error:/m.test(sample)) {
    bump("error_diagnostic", 0.76);
  }
  // ERROR/FATAL alone (without structured file:line format) is weaker signal
  if (/\b(ERROR|FATAL)\b/.test(sample) && !/\b(WARN(ING)?)\b/.test(sample)) {
    bump("error_diagnostic", 0.72);
  }
  // Multi-language test result patterns
  if (/^test result: (ok|FAILED)/m.test(sample)) {
    bump("test_results", 0.9); // cargo test
  }
  if (/^--- (PASS|FAIL): /m.test(sample)) {
    bump("test_results", 0.9); // go test
  }
  if (/^={3,}\s*(test session starts|FAILURES)/m.test(sample)) {
    bump("test_results", 0.9); // pytest
  }
  if (/^\d+ examples?, \d+ failures?/m.test(sample)) {
    bump("test_results", 0.88); // rspec
  }
  if (/^[│├└┌]|\|\s*[\w.]+\s*\|/.test(sample)) {
    bump("tree_paths", 0.7);
  }
  if (/^\w+=[^\s]+$/m.test(sample) && sample.split("\n").length > 3) {
    bump("key_value", 0.72);
  }

  // Ansible recap / task headers
  if (/^PLAY RECAP/m.test(sample)) bump("log_text", 0.85);
  if (/^(TASK|PLAY) \[/m.test(sample)) bump("log_text", 0.83);

  // Terraform plan
  if (/^(Plan:|Terraform will perform|# .+ will be)/m.test(sample))
    bump("log_text", 0.8);
  if (/^[~+\-] resource|^\s+\+ .+ = /m.test(sample)) bump("log_text", 0.78);

  // Playwright tests
  if (/\[(chromium|firefox|webkit)\]\s+›/.test(sample))
    bump("test_results", 0.88);
  // Generic: ✓/✗ with durations
  if (/^\s*[✓✔✗✘×]\s+.+\(\d+m?s\)/m.test(sample)) bump("test_results", 0.82);

  // kubectl describe (multi-field key: value)
  {
    const k8sFields =
      /^(Name|Namespace|Labels|Annotations|Status|Type|Containers|Volumes|Conditions|Events|Node|IP|Port):\s/m;
    const k8sMatches = lines
      .slice(0, 20)
      .filter((l) => k8sFields.test(l)).length;
    if (k8sMatches >= 4) bump("key_value", 0.82);
  }

  // Docker compose progress
  if (
    /^\[?\+?\]?\s*(Creating|Starting|Stopping|Removing|Running)\s+\S+\s*\.{3}/m.test(
      sample
    )
  )
    bump("log_text", 0.78);

  // Shellcheck
  if (/^In .+ line \d+:/m.test(sample)) bump("error_diagnostic", 0.88);

  // Security scanner output (npm audit, snyk, trivy)
  if (
    /\b(vulnerabilit|CVE-\d{4}|GHSA-|critical|moderate|high|low)\b/i.test(
      sample
    ) &&
    /\d+ (vulnerabilit|issue|finding)/i.test(sample)
  )
    bump("error_diagnostic", 0.8);

  // systemd/systemctl status
  if (/^\s*(Loaded|Active|Main PID|CGroup|Memory|CPU):/m.test(sample))
    bump("key_value", 0.82);

  // Cloud deploy progress
  if (
    /\b(Deploying|Uploading|Provisioning|Creating stack|Updating stack)\b/i.test(
      sample
    )
  )
    bump("progress_streaming", 0.76);

  return best;
}

/**
 * Passthrough commands — these just display content from files/pipes,
 * so the content itself is the real signal for classification.
 * When content heuristic is strong (>= 0.85), it overrides these hints.
 */
const PASSTHROUGH_COMMANDS = new Set([
  "cat",
  "tail",
  "less",
  "head",
  "grep",
  "rg",
  "ag",
]);

/**
 * Classify shell stdout for compression strategy selection.
 * Uses stripped (no ANSI) text for content phase.
 */
export function classifyShellOutput(
  command: string,
  strippedStdout: string
): ClassifyResult {
  const head = strippedStdout.split("\n").slice(0, 20);

  const hint = matchCommandHint(command);
  const content = scoreContent(head);

  if (hint) {
    const agree = content && content.category === hint.category;

    // Passthrough commands (cat, tail, less, etc.) just display content —
    // let strong content signals override when they disagree.
    if (
      !agree &&
      content &&
      content.score >= 0.85 &&
      PASSTHROUGH_COMMANDS.has(hint.key.split(" ")[0] ?? "")
    ) {
      return {
        category: content.category,
        confidence: content.score,
        hint_source: "content_heuristic",
      };
    }

    return {
      category: hint.category,
      confidence: agree ? CONFIDENCE_BOTH : CONFIDENCE_HINT,
      hint_source: agree ? "both" : "command_name",
    };
  }

  if (content) {
    return {
      category: content.category,
      confidence: Math.min(0.88, content.score),
      hint_source: "content_heuristic",
    };
  }

  return {
    category: "structured",
    confidence: 0.42,
    hint_source: "content_heuristic",
  };
}
