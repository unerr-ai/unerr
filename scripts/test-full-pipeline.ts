/**
 * Test the FULL compression pipeline (classifier → strategy-specific compressor)
 * with real commands and realistic synthetic outputs, measuring actual compression.
 */
import { compressShellOutput, stripAnsiCodes } from '../src/proxy/shell-compressor.js';
import { execSync } from 'child_process';

const ROOT = '/Users/jaswanth/IdeaProjects/unerr-cli';

interface Result {
  label: string;
  cmd: string;
  category: string;
  confidence: number;
  source: string;
  inLines: number;
  inChars: number;
  outLines: number;
  outChars: number;
  pct: number;
}

const results: Result[] = [];

async function test(label: string, cmd: string, rawInput: string, exitCode?: number) {
  const stripped = stripAnsiCodes(rawInput);
  if (stripped.length < 5) return;
  const { text, classification } = await compressShellOutput(cmd, rawInput, { persistStats: false, exitCode });
  const inChars = stripped.length;
  const outChars = text.length;
  const pct = Math.max(0, (1 - outChars / inChars) * 100);
  const inLines = stripped.split('\n').length;
  const outLines = text.split('\n').length;

  results.push({
    label, cmd, category: classification.category,
    confidence: classification.confidence, source: classification.hint_source,
    inLines, inChars, outLines, outChars, pct,
  });

  console.log(`\n─── ${label} ───`);
  console.log(`  cmd:         ${cmd}`);
  console.log(`  strategy:    ${classification.category} (conf ${classification.confidence.toFixed(2)}, ${classification.hint_source})`);
  console.log(`  input:       ${inLines} lines, ${inChars} chars`);
  console.log(`  output:      ${outLines} lines, ${outChars} chars`);
  console.log(`  compression: ${pct.toFixed(1)}%`);
}

function execCmd(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, cwd: ROOT, timeout: 15000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  } catch (e: any) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

async function main() {
  console.log('Running full pipeline (classifier → strategy) compression tests...\n');

  // ════════════════════════════════════════════════════════
  // REAL COMMANDS
  // ════════════════════════════════════════════════════════

  await test('git diff HEAD~3 (full)', 'git diff HEAD~3', execCmd('git diff HEAD~3'));
  await test('git diff HEAD~5 --stat', 'git diff HEAD~5 --stat', execCmd('git diff HEAD~5 --stat'));
  await test('git log verbose (20)', 'git log -20 --format=fuller', execCmd('git log -20 --format=fuller'));
  await test('git log oneline (50)', 'git log --oneline -50', execCmd('git log --oneline -50'));
  await test('git status', 'git status', execCmd('git status'));
  await test('git branch -a', 'git branch -a', execCmd('git branch -a'));
  await test('ls -lR src/', 'ls -lR src/', execCmd('ls -lR src/'));
  await test('ls -la root', 'ls -la', execCmd('ls -la'));
  await test('find src .ts files', 'find src -name "*.ts" -type f', execCmd('find src -name "*.ts" -type f'));
  await test('find src all files', 'find src -type f', execCmd('find src -type f'));
  await test('ps aux', 'ps aux', execCmd('ps aux'));
  await test('du -sh src/*', 'du -sh src/*', execCmd('du -sh src/*'));
  await test('env', 'env', execCmd('env'));
  await test('pnpm ls depth 2', 'pnpm ls --depth 2', execCmd('pnpm ls --depth 2'));
  await test('pnpm ls depth 0', 'pnpm ls --depth 0', execCmd('pnpm ls --depth 0'));
  await test('wc -l .ts files', 'find src -name "*.ts" -exec wc -l {} +', execCmd('find src -name "*.ts" -exec wc -l {} +'));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: TEST RESULTS
  // ════════════════════════════════════════════════════════

  await test('vitest 500 tests (3 fail)', 'pnpm exec vitest run', [
    ' RUN  v3.2.4 /home/user/project',
    '',
    ...Array.from({ length: 497 }, (_, i) =>
      ` ✓ src/${['auth', 'api', 'db', 'utils', 'config'][i % 5]}.test.ts > ${['create', 'read', 'update', 'delete', 'list'][i % 5]} > case ${i} 2ms`
    ),
    ` ✗ src/auth.test.ts > login > rejects bad password`,
    '   AssertionError: expected 200 to be 401',
    '     at Object.<anonymous> (src/auth.test.ts:42:12)',
    '',
    ` ✗ src/api.test.ts > users > returns 404`,
    '   AssertionError: expected 200 to be 404',
    '     at Object.<anonymous> (src/api.test.ts:89:12)',
    '',
    ` ✗ src/db.test.ts > migration > rollback`,
    '   Error: Migration failed: column "email" already exists',
    '     at Object.<anonymous> (src/db.test.ts:15:8)',
    '',
    ' Test Files  5 passed | 3 failed (8)',
    '      Tests  497 passed | 3 failed (500)',
    '   Duration  4.21s',
  ].join('\n'), 1);

  await test('pytest 200 tests (5 fail)', 'pytest tests/', [
    '============================= test session starts =============================',
    'platform linux -- Python 3.12.0, pytest-8.0.0',
    'collected 200 items',
    '',
    ...Array.from({ length: 195 }, (_, i) =>
      `tests/test_${['auth', 'api', 'db', 'utils', 'config'][i % 5]}.py::test_${['create', 'read', 'update', 'delete', 'list'][i % 5]}_${i} PASSED`
    ),
    'tests/test_auth.py::test_login_expired FAILED',
    'tests/test_api.py::test_rate_limit FAILED',
    'tests/test_db.py::test_concurrent_write FAILED',
    'tests/test_utils.py::test_parse_date FAILED',
    'tests/test_config.py::test_missing_env FAILED',
    '',
    '=================================== FAILURES ===================================',
    '_________________________________ test_login_expired __________________________',
    '    def test_login_expired():',
    '>       assert auth.login(expired_token) == False',
    'E       AssertionError: assert True == False',
    'tests/test_auth.py:42: AssertionError',
    '',
    '_________________________________ test_rate_limit _____________________________',
    '    def test_rate_limit():',
    '>       assert response.status_code == 429',
    'E       AssertionError: assert 200 == 429',
    'tests/test_api.py:89: AssertionError',
    '',
    '=========================== short test summary info ============================',
    'FAILED tests/test_auth.py::test_login_expired',
    'FAILED tests/test_api.py::test_rate_limit',
    'FAILED tests/test_db.py::test_concurrent_write',
    'FAILED tests/test_utils.py::test_parse_date',
    'FAILED tests/test_config.py::test_missing_env',
    '========================= 5 failed, 195 passed in 12.34s =====================',
  ].join('\n'), 1);

  await test('cargo test 100 tests (2 fail)', 'cargo test', [
    '   Compiling my-project v0.1.0',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 5.23s',
    '     Running unittests src/lib.rs (target/debug/deps/my_project-abc123)',
    '',
    ...Array.from({ length: 98 }, (_, i) => `test ${['auth', 'api', 'db', 'utils'][i % 4]}::test_${i} ... ok`),
    'test auth::test_expired_token ... FAILED',
    'test db::test_deadlock ... FAILED',
    '',
    'failures:',
    '',
    '---- auth::test_expired_token stdout ----',
    "thread 'auth::test_expired_token' panicked at 'assertion failed: `(left == right)`",
    "  left: `true`,",
    " right: `false`', src/auth.rs:42:9",
    '',
    '---- db::test_deadlock stdout ----',
    "thread 'db::test_deadlock' panicked at 'called `Result::unwrap()` on an `Err` value: Deadlock'",
    '',
    'failures:',
    '    auth::test_expired_token',
    '    db::test_deadlock',
    '',
    'test result: FAILED. 98 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.42s',
  ].join('\n'), 1);

  await test('go test 80 tests (1 fail)', 'go test ./...', [
    ...Array.from({ length: 79 }, (_, i) => `--- PASS: Test${['Auth', 'API', 'DB', 'Utils'][i % 4]}${i} (0.${String(i % 100).padStart(2, '0')}s)`),
    '--- FAIL: TestAuthExpired (0.12s)',
    '    auth_test.go:42: expected false, got true',
    'FAIL',
    'FAIL    github.com/user/project/auth  2.345s',
    'ok      github.com/user/project/api   1.234s',
    'ok      github.com/user/project/db    0.567s',
    'ok      github.com/user/project/utils 0.123s',
  ].join('\n'), 1);

  await test('rspec 150 examples (4 fail)', 'bundle exec rspec', [
    'Randomized with seed 12345',
    '',
    ...Array.from({ length: 146 }, () => '.'),
    'F', 'F', 'F', 'F',
    '',
    'Failures:',
    '',
    '  1) User#authenticate rejects expired tokens',
    '     Failure/Error: expect(user.authenticate(expired)).to be_falsey',
    '       expected: falsey value',
    '            got: true',
    '     # ./spec/models/user_spec.rb:42',
    '',
    '  2) API::Users#index returns paginated results',
    '     Failure/Error: expect(response.body.size).to eq(10)',
    '       expected: 10',
    '            got: 25',
    '     # ./spec/requests/api/users_spec.rb:89',
    '',
    '  3) Database::Migration#rollback handles constraints',
    '     Failure/Error: expect { migration.rollback }.not_to raise_error',
    '       expected no error, got ActiveRecord::StatementInvalid',
    '     # ./spec/lib/migration_spec.rb:15',
    '',
    '  4) Config#load raises on missing env',
    '     Failure/Error: expect { Config.load }.to raise_error(KeyError)',
    '       expected KeyError but nothing was raised',
    '     # ./spec/lib/config_spec.rb:28',
    '',
    'Finished in 8.92 seconds (files took 2.34 seconds to load)',
    '150 examples, 4 failures',
    '',
    'Failed examples:',
    '',
    'rspec ./spec/models/user_spec.rb:40',
    'rspec ./spec/requests/api/users_spec.rb:85',
    'rspec ./spec/lib/migration_spec.rb:12',
    'rspec ./spec/lib/config_spec.rb:25',
  ].join('\n'), 1);

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: ERROR DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  await test('tsc 40 errors', 'tsc --noEmit', [
    ...Array.from({ length: 40 }, (_, i) => {
      const codes = ['TS2345', 'TS7006', 'TS2322', 'TS2304', 'TS18046'];
      const msgs = [
        "Argument of type 'string' is not assignable to parameter of type 'number'.",
        "Parameter 'x' implicitly has an 'any' type.",
        "Type 'null' is not assignable to type 'string'.",
        "Cannot find name 'undeclared'.",
        "'obj' is of type 'unknown'.",
      ];
      return `src/${['auth', 'api', 'db', 'utils', 'config'][i % 5]}.ts(${10 + i},${5 + (i % 20)}): error ${codes[i % 5]}: ${msgs[i % 5]}`;
    }),
    '',
    'Found 40 errors in 5 files.',
  ].join('\n'), 1);

  await test('eslint 30 errors', 'npx eslint src/', [
    '',
    ...Array.from({ length: 30 }, (_, i) => {
      const rules = ['no-unused-vars', '@typescript-eslint/no-explicit-any', 'prefer-const', 'no-console', '@typescript-eslint/no-floating-promises'];
      const sev = i % 3 === 0 ? 'error' : 'warning';
      return `  ${10 + i}:${5 + (i % 30)}  ${sev}  ${['Unexpected any', "'x' is defined but never used", "Use 'const' instead of 'let'", 'Unexpected console statement', 'Promises must be awaited'][i % 5]}  ${rules[i % 5]}`;
    }),
    '',
    '✖ 30 problems (10 errors, 20 warnings)',
  ].join('\n'), 1);

  await test('gcc 25 errors', 'gcc -Wall src/*.c', [
    ...Array.from({ length: 25 }, (_, i) => {
      const files = ['main.c', 'utils.c', 'parser.c', 'network.c', 'config.c'];
      const msgs = [
        "error: expected ';' after expression",
        "warning: implicit declaration of function 'foo'",
        "error: use of undeclared identifier 'bar'",
        "warning: unused variable 'x'",
        "error: incompatible pointer types passing 'int *' to parameter of type 'char *'",
      ];
      return `src/${files[i % 5]}:${10 + i * 3}:${5 + (i % 15)}: ${msgs[i % 5]}`;
    }),
    '15 errors generated.',
  ].join('\n'), 1);

  await test('rustc 20 errors', 'cargo check', [
    ...Array.from({ length: 20 }, (_, i) => {
      const codes = ['E0308', 'E0425', 'E0382', 'E0277', 'E0599'];
      const msgs = [
        'mismatched types',
        'cannot find value `x` in this scope',
        'use of moved value: `data`',
        "the trait bound `String: Copy` is not satisfied",
        "no method named `foo` found for struct `Bar`",
      ];
      return [
        `error[${codes[i % 5]}]: ${msgs[i % 5]}`,
        `  --> src/${['main', 'lib', 'auth', 'api'][i % 4]}.rs:${10 + i * 5}:${5 + i}`,
        '   |',
        `${10 + i * 5} |     let x = something;`,
        '   |             ^^^^^^^^^ error here',
        '',
      ].join('\n');
    }),
    'error: aborting due to 20 previous errors',
    '',
    'For more information about this error, try `rustc --explain E0308`.',
  ].join('\n'), 1);

  await test('mypy 30 errors', 'mypy src/', [
    ...Array.from({ length: 30 }, (_, i) => {
      const files = ['auth.py', 'api.py', 'db.py', 'utils.py', 'config.py'];
      const msgs = [
        'error: Argument 1 to "process" has incompatible type "str"; expected "int"',
        'error: "User" has no attribute "email_addr"',
        'error: Incompatible return value type (got "None", expected "Response")',
        'error: Missing return statement',
        'error: Cannot determine type of "data"',
      ];
      return `src/${files[i % 5]}:${10 + i * 2}: ${msgs[i % 5]}`;
    }),
    'Found 30 errors in 5 files (checked 15 source files)',
  ].join('\n'), 1);

  await test('python traceback (5 chained)', 'python app.py', [
    ...Array.from({ length: 5 }, (_, i) => [
      'Traceback (most recent call last):',
      `  File "/app/${['main', 'handler', 'processor', 'service', 'worker'][i]}.py", line ${42 + i * 10}, in ${['process', 'handle', 'run', 'execute', 'dispatch'][i]}`,
      `    result = ${['db.query(sql)', 'api.call(url)', 'parser.parse(data)', 'cache.get(key)', 'queue.pop()'][i]}`,
      `  File "/app/${['db', 'api', 'parser', 'cache', 'queue'][i]}.py", line ${15 + i * 5}, in ${['query', 'call', 'parse', 'get', 'pop'][i]}`,
      `    return ${['cursor.execute(sql)', 'requests.get(url)', 'json.loads(data)', 'redis.get(key)', 'self.items.pop()'][i]}`,
      `${['psycopg2.OperationalError: connection refused', 'requests.ConnectionError: Max retries exceeded', 'json.JSONDecodeError: Expecting value', 'redis.ConnectionError: Connection refused', 'IndexError: pop from empty list'][i]}`,
      '',
    ].join('\n')).join('\n'),
  ].join('\n'), 1);

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: LOG / BUILD OUTPUT
  // ════════════════════════════════════════════════════════

  await test('500-line server log', 'tail -f /var/log/app.log', Array.from({ length: 500 }, (_, i) =>
    `2024-01-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z [${i % 20 === 0 ? 'ERROR' : i % 7 === 0 ? 'WARN' : 'INFO'}] ${['RequestHandler', 'AuthMiddleware', 'DBPool', 'CacheLayer', 'QueueWorker'][i % 5]}: ${['processed request', 'validated token', 'executed query', 'cache hit', 'dequeued job'][i % 5]} id=${i} latency=${10 + i}ms`
  ).join('\n'));

  await test('200-crate cargo build', 'cargo build --release', [
    ...Array.from({ length: 200 }, (_, i) => `   Compiling dep-${String.fromCharCode(65 + i % 26)}${Math.floor(i / 26)} v0.${i}.0`),
    '   Compiling my-project v1.0.0 (/home/user/project)',
    'warning: unused variable: `x`',
    '  --> src/lib.rs:42:9',
    'warning: unused import: `std::fmt`',
    '  --> src/main.rs:3:5',
    '    Finished `release` profile [optimized] target(s) in 45.23s',
  ].join('\n'));

  await test('webpack build (150 modules)', 'npm run build', [
    '> my-app@1.0.0 build',
    '> webpack --mode production',
    '',
    ...Array.from({ length: 150 }, (_, i) =>
      `  [${i}] ./src/components/${String.fromCharCode(65 + i % 26)}${Math.floor(i / 26)}.tsx ${(1 + i * 0.3).toFixed(1)} KiB {main} [built]`
    ),
    '',
    'WARNING in ./src/legacy.ts',
    'Module Warning (from ./node_modules/source-map-loader/dist/cjs.js):',
    "Failed to parse source map from '/home/user/project/src/legacy.ts.map'",
    '',
    'WARNING in asset size limit: The following asset(s) exceed the recommended size limit (244 KiB).',
    '  main.js (1.23 MiB)',
    '',
    'webpack 5.90.0 compiled with 2 warnings in 12340ms',
  ].join('\n'));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: PROGRESS / INSTALL
  // ════════════════════════════════════════════════════════

  await test('npm install 300 pkgs', 'npm install', [
    ...Array.from({ length: 300 }, (_, i) =>
      `npm http fetch GET 200 https://registry.npmjs.org/pkg-${String.fromCharCode(97 + i % 26)}${Math.floor(i / 26)} ${10 + i}ms`
    ),
    '',
    'added 347 packages, removed 12 packages, and audited 1,892 packages in 28s',
    '',
    '142 packages are looking for funding',
    '  run `npm fund` for details',
    '',
    'found 0 vulnerabilities',
  ].join('\n'));

  await test('pip install 50 pkgs', 'pip install -r requirements.txt', [
    ...Array.from({ length: 50 }, (_, i) =>
      `Collecting package-${String.fromCharCode(97 + i % 26)}${Math.floor(i / 26)}==${i}.0.0`
    ),
    ...Array.from({ length: 50 }, (_, i) =>
      `  Downloading package_${String.fromCharCode(97 + i % 26)}${Math.floor(i / 26)}-${i}.0.0-py3-none-any.whl (${100 + i * 10} kB)`
    ),
    `Successfully installed ${Array.from({ length: 50 }, (_, i) => `package-${String.fromCharCode(97 + i % 26)}${Math.floor(i / 26)}-${i}.0.0`).join(' ')}`,
  ].join('\n'));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: TABULAR
  // ════════════════════════════════════════════════════════

  await test('docker ps 100 containers', 'docker ps', [
    'CONTAINER ID   IMAGE                    COMMAND                  CREATED          STATUS          PORTS                    NAMES',
    ...Array.from({ length: 100 }, (_, i) =>
      `${(0xabcdef0 + i).toString(16).padStart(12, '0')}   nginx:1.${i % 25}              "/docker-entrypoint.…"   ${i + 1} hours ago   Up ${i + 1} hours   0.0.0.0:${8000 + i}->80/tcp   web-${String.fromCharCode(97 + i % 26)}-${Math.floor(i / 26)}`
    ),
  ].join('\n'));

  await test('kubectl get pods 80', 'kubectl get pods', [
    'NAME                                    READY   STATUS             RESTARTS   AGE',
    ...Array.from({ length: 80 }, (_, i) =>
      `app-${['api', 'web', 'worker', 'cron'][i % 4]}-${(0xabc + i).toString(16).padEnd(7)}   1/1     ${i % 15 === 0 ? 'CrashLoopBackOff' : 'Running'}     ${i % 15 === 0 ? i : 0}          ${i + 1}d`
    ),
  ].join('\n'));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: TREE / PATHS
  // ════════════════════════════════════════════════════════

  await test('find 500 files', 'find . -type f', Array.from({ length: 500 }, (_, i) =>
    `./src/${['components', 'utils', 'hooks', 'services', 'models'][i % 5]}/${String.fromCharCode(65 + i % 26)}${Math.floor(i / 26)}.${['ts', 'tsx', 'test.ts', 'spec.ts'][i % 4]}`
  ).join('\n'));

  await test('tree src 3 levels', 'tree src', [
    'src',
    ...Array.from({ length: 200 }, (_, i) => {
      const depth = i % 4;
      const prefix = '│   '.repeat(depth) + (i % 3 === 0 ? '├── ' : '└── ');
      return `${prefix}${['components', 'utils', 'hooks'][i % 3]}${depth > 0 ? `/${String.fromCharCode(65 + i % 26)}.ts` : ''}`;
    }),
    '',
    '42 directories, 158 files',
  ].join('\n'));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: STRUCTURED
  // ════════════════════════════════════════════════════════

  await test('docker inspect (long JSON)', 'docker inspect abc123', JSON.stringify([{
    Id: 'sha256:abc123def456',
    Config: {
      Hostname: 'abc123',
      Env: Array.from({ length: 30 }, (_, i) => `VAR_${i}=value_${i}`),
      Cmd: ['/bin/sh', '-c', 'node server.js'],
      Labels: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`label.${i}`, `value-${i}`])),
    },
    NetworkSettings: {
      Networks: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`net-${i}`, { IPAddress: `172.17.0.${i + 2}`, Gateway: '172.17.0.1' }])),
    },
    Mounts: Array.from({ length: 10 }, (_, i) => ({ Source: `/host/path/${i}`, Destination: `/container/path/${i}`, Mode: 'rw' })),
  }], null, 2));

  await test('curl JSON API response', 'curl https://api.example.com/users', JSON.stringify({
    data: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `User ${String.fromCharCode(65 + i % 26)}${Math.floor(i / 26)}`,
      email: `user${i}@example.com`,
      created_at: `2024-01-${String(1 + i % 28).padStart(2, '0')}T00:00:00Z`,
      roles: ['admin', 'user', 'viewer'].slice(0, (i % 3) + 1),
    })),
    meta: { total: 1000, page: 1, per_page: 100 },
  }, null, 2));

  // ════════════════════════════════════════════════════════
  // SYNTHETIC: KEY-VALUE
  // ════════════════════════════════════════════════════════

  await test('env 80 vars', 'env', Array.from({ length: 80 }, (_, i) =>
    `${['HOME', 'PATH', 'SHELL', 'USER', 'LANG', 'TERM', 'EDITOR', 'DISPLAY', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME'][i % 10]}_${i}=/usr/local/${String.fromCharCode(97 + i % 26)}/${i}`
  ).join('\n'));

  await test('git config list', 'git config --list', Array.from({ length: 40 }, (_, i) =>
    `${['user', 'core', 'remote', 'branch', 'alias'][i % 5]}.${['name', 'email', 'editor', 'autocrlf', 'pager'][i % 5]}=${['value', '/usr/bin/vim', 'true', 'false', 'less'][i % 5]}`
  ).join('\n'));

  // ════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════

  console.log('\n\n' + '═'.repeat(95));
  console.log('                         FULL PIPELINE COMPRESSION RESULTS');
  console.log('═'.repeat(95));
  console.log(`${'Label'.padEnd(36)} ${'Strategy'.padEnd(20)} ${'In'.padStart(8)} ${'Out'.padStart(8)} ${'Saved'.padStart(7)}`);
  console.log('─'.repeat(81));

  let totalIn = 0, totalOut = 0;
  const byStrategy = new Map<string, { inTotal: number; outTotal: number; count: number }>();

  for (const r of results) {
    totalIn += r.inChars;
    totalOut += r.outChars;
    const s = byStrategy.get(r.category) ?? { inTotal: 0, outTotal: 0, count: 0 };
    s.inTotal += r.inChars;
    s.outTotal += r.outChars;
    s.count++;
    byStrategy.set(r.category, s);
    console.log(`${r.label.slice(0, 36).padEnd(36)} ${r.category.padEnd(20)} ${String(r.inChars).padStart(8)} ${String(r.outChars).padStart(8)} ${r.pct.toFixed(1).padStart(6)}%`);
  }

  console.log('─'.repeat(81));
  const totalPct = ((1 - totalOut / totalIn) * 100).toFixed(1);
  console.log(`${'TOTAL'.padEnd(36)} ${''.padEnd(20)} ${String(totalIn).padStart(8)} ${String(totalOut).padStart(8)} ${totalPct.padStart(6)}%`);

  console.log(`\n${'Strategy'.padEnd(22)} ${'Tests'.padStart(6)} ${'Avg Compression'.padStart(18)}`);
  console.log('─'.repeat(48));
  for (const [strategy, s] of [...byStrategy.entries()].sort((a, b) => b[1].inTotal - a[1].inTotal)) {
    const pct = ((1 - s.outTotal / s.inTotal) * 100).toFixed(1);
    console.log(`${strategy.padEnd(22)} ${String(s.count).padStart(6)} ${(pct + '%').padStart(18)}`);
  }
  console.log('─'.repeat(48));

  console.log(`\nOverall: ${(totalIn / 1024).toFixed(1)}KB → ${(totalOut / 1024).toFixed(1)}KB (${totalPct}% compression, saved ${((totalIn - totalOut) / 1024).toFixed(1)}KB)`);
}

main().catch(console.error);
