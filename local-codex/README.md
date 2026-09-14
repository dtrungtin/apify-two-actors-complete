# Local Codex tooling

Runs on your machine with **your** Apify account. It turns a waiting Generator Actor run (Actor #2) into a
finished Actor ZIP and uploads that ZIP back, which lets Actor #2 finish and Actor #1 deliver the ZIP to the
customer.

```text
Generator Run ID
   │
   ▼
fetch-request   reads GENERATION_REQUEST from the run's key-value store
   │            -> work/<runId>/request.json, REQUIREMENTS.md
   │            revision: also downloads PREVIOUS_ACTOR_ZIP -> work/<runId>/previous-actor.zip
   ▼
scaffold        new Actor: copies template/ and fills in the placeholders
   │            revision: unpacks previous-actor.zip, adds any missing required file from the template
   ▼
generate        writes PROMPT.md (new-Actor or revision prompt) and runs Codex or your own command
   ▼
validate        layout + actor.json + input schema + apify validate-schema + anti-pattern checks
   │            + optional local run
   ▼
package-zip     work/<runId>/<actor-name>.zip, all files at the archive root
   ▼
upload-zip      GENERATED_ACTOR_ZIP (application/zip) into the run's key-value store,
                archive copy into the named store "generated-actors", then waits for Actor #2 to finish
```

## Prerequisites

- Node.js 18 or newer and `npm install` in this folder.
- `APIFY_TOKEN` set to the token of the account that owns Actor #2 (the same value Actor #1 gets as `TOKEN`).
- Recommended: Apify CLI (`npm i -g apify-cli`, then `apify login`). It enables `apify validate-schema`
  and the `apify run` smoke test, and it is the easiest way to deploy.
- Optional: the Codex CLI on your `PATH` for unattended generation. Without it, the generate step prints the
  prompt location and you run Codex yourself.

## One command

```bash
npm run pipeline -- <generatorRunId> --run
```

The Generator Run ID is the run ID of Actor #2 in your account; its status message shows it as `Request ID: ...`
(the wording is deliberately neutral, and the customer never sees that run's log). Revision requests are detected
automatically from the request record.

Exit codes: `0` uploaded, `1` something failed (fix `work/<runId>/actor/` and rerun with `--skip-generate`),
`2` generation has to be done manually. After a manual generation continue with:

```bash
npm run pipeline -- <generatorRunId> --skip-generate --run
```

Useful flags: `--skip-upload` to stop after the ZIP, `--force` to re-scaffold and to upload even when the run is
no longer RUNNING, `--input <file>` to use your own smoke-test input, `--timeout <secs>` for the smoke run,
`--wait <secs>` for how long to wait for Actor #2 after upload, `--no-archive` to skip the archive copy,
`--tier standard|advanced|revision|free` to override the automatic billing tier (see "Billing" below).
`--help` on any script lists everything.

## Billing

The upload step decides the billing tier by itself (`src/billing.js`) and prints the decision with its reasons:

- **New Actor**: `standard`, or `advanced` when the complexity score reaches 2. Score: browser automation
  dependency or crawler class 2; authentication or secret inputs 1; 500 or more functional source lines 1; 8 or more
  input fields 1; third-party service integrations 1.
- **Revision**: `free` when code, schema and dependencies are unchanged (comments, README and version bumps are
  ignored); `free` for a problem report within 7 days of the last billable delivery (the `warrantyAnchorAt` read
  from the archive meta or the delivery index; free deliveries carry the anchor forward, billable ones reset it, and
  records without the field count from their upload date);
  billed like a new Actor when 40% or more of functional lines changed or 2 or more source files were added;
  otherwise `revision`.

The measurements (complexity signals, changed lines, changed ratio, previous delivery date) are stored in
`GENERATED_ACTOR_META.billing`, and the customer Actor charges the matching event and shows the label to the
customer. `--tier` overrides the decision and records both the override and what the automatic decision would
have been.

## Step by step

| Command | What it does |
| --- | --- |
| `npm run fetch -- <runId>` | Downloads the request (and the previous ZIP for a revision). Warns if the run is not RUNNING or a ZIP was already uploaded. |
| `npm run scaffold -- <runId>` | Creates `work/<runId>/actor/` from `template/`, or from the previous ZIP for a revision. Keeps an existing folder unless `--force`. |
| `npm run generate -- <runId>` | Writes `PROMPT.md`; runs `GENERATE_CMD`, else `codex exec`, else prints manual instructions. |
| `npm run validate -- <runId> --run` | Structural checks, `node --check`, anti-pattern checks, `apify validate-schema`, then `npm install` + `apify run --purge`. |
| `npm run zip -- <runId>` | Builds the ZIP and re-opens it to confirm every required file sits at the archive root. |
| `npm run upload -- <runId>` | Uploads the ZIP, downloads it again to compare hashes, archives it, then polls the run status. |

## Revisions

When a customer reuses the Actor name of one of their earlier successful runs, Actor #1 copies that run's ZIP
into your account and Actor #2 stages it as `PREVIOUS_ACTOR_ZIP`, recording whether it still matches the
original delivery (`previousZip.integrity`: `verified`, `modified` or `unknown`). The request record then
carries `revision: true`. The tooling:

- downloads that ZIP to `work/<runId>/previous-actor.zip` and unpacks it as the working folder (path traversal
  is blocked, `node_modules/` and `storage/` inside the ZIP are ignored, a single wrapper folder is stripped);
- adds any required file the ZIP lacks from the template;
- writes a revision prompt: current files, original requirements, the requested change, keep the Actor `name`,
  bump the minor version, add a Changelog entry;
- validates, zips and uploads as usual.

The ZIP passed through the customer's storage, so treat it as code you did not write until its integrity is
`verified`. `fetch-request` prints the verdict, and `validate --run` refuses to execute an unverified revision
unless you pass `--allow-untrusted-run` after reviewing the code.

## Problem reports

When the customer attached a problem report (error log, failing input, failed run ID), `fetch-request` saves the
evidence as `work/<runId>/reported-error.log` and `reported-input.json` and adds a "Reported failure" section to
`REQUIREMENTS.md`. The prompt quotes the log between `BEGIN CUSTOMER LOG` and `END CUSTOMER LOG` markers with an
instruction to treat it as data, so a crafted log cannot steer the generation. Two extra steps use the failing input:

```bash
npm run pipeline -- <runId> --reproduce --run      # or: npm run reproduce -- <runId>
```

- `--reproduce` runs the unpacked previous version with the reported input before any code changes and reports
  whether the failure reproduces (exit code 2 from `reproduce.js` when it does not).
- `validate --run` runs the reported input after the prefill smoke test and fails when it still does not succeed,
  so an incomplete fix cannot be shipped.

Both respect the integrity guard: an unverified previous ZIP is not executed without `--allow-untrusted-run`.

## Cloud test

Some behaviour only exists on the platform, for example Apify Proxy, which the account cannot use from outside
Apify. `cloud-test` pushes the generated source into the private test Actor `dtrungtin/actor-generator-test-actor`
(override with `--test-actor` or `LOCAL_CODEX_TEST_ACTOR`), runs it there and saves the outcome:

```bash
npm run cloud-test -- <runId> --input proxy-input.json --memory 256
npm run pipeline -- <runId> --skip-generate --run --cloud-test --cloud-input proxy-input.json
```

It copies the source (without `node_modules/`, `storage/` and ZIPs) to a temporary folder outside the repo, because
`apify push` honours parent `.gitignore` files and this repo ignores `local-codex/work/`, which would otherwise upload
nothing and build the base image's placeholder. It then builds with `apify push <testActor> --dir ... --force`,
checks that the platform received `src/main.js`, `package.json` and `Dockerfile`, runs the build with the given input
(default: schema prefill; `--reported` uses the problem report's failing input), and stores `cloud-test.json` plus the
full run log in `cloud-test.log`. Exit code 0 only when the run SUCCEEDED. In the pipeline, `--cloud-test` runs after
validation and a failed cloud run stops before packaging. Cloud runs consume your account's compute; keep memory low.

## Archive

Every upload also writes `<generatorRunId>.zip` and `<generatorRunId>.json` (request, file list, SHA-256) into
the named key-value store `generated-actors` in your account, and updates `index-<customerUserId>.json`, a
per-customer map from the normalised Actor name to the latest generator run. Actor #2 uses that index to
recognise a revision on its own (same customer, same Actor name) and falls back to the archived ZIP when the
previous run's storage has expired. Override the store name with `LOCAL_CODEX_ARCHIVE_STORE` (and
`ARCHIVE_STORE_NAME` on Actor #2), or skip archiving with `--no-archive` (the index is then not updated either,
so that delivery cannot be revised automatically).

## Generation options

1. `GENERATE_CMD` (or `--command "..."`): any shell command, run with the actor folder as working directory.
   It receives `ACTOR_DIR`, `PROMPT_FILE`, `REQUEST_FILE`, `REQUIREMENTS_FILE` and `GENERATOR_RUN_ID` as
   environment variables. Quote executable paths that contain spaces.
2. `codex` on `PATH`: runs
   `codex exec --sandbox workspace-write --skip-git-repo-check -C <actorDir> -o <codex-last-message.md> -`
   with the prompt on stdin. `CODEX_MODEL` adds `--model`, `CODEX_EXTRA_ARGS` appends more flags.
3. Neither: open `work/<runId>/actor/` in Codex, paste `work/<runId>/PROMPT.md`, then rerun with `--skip-generate`.

## Validation rules worth knowing

- Every input-schema property needs `title`, `type`, `description`, and `editor` for string, array and object.
  Apify's build rejects schemas without descriptions.
- `Actor.exit()` inside a `finally` block is an error: after a throw it exits with code 0 and the run is marked
  `SUCCEEDED`. Use `Actor.fail(message)` in the catch block.
- The smoke run uses the schema's `prefill`/`default` values unless you pass `--input`.

## What the ZIP contains

Exactly the layout the customer imports into Apify, with nothing wrapped in a top-level folder:

```text
<actor-name>.zip
├── .actor/
│   ├── actor.json
│   └── input_schema.json
├── src/
│   └── main.js          (plus any other src/ files)
├── package.json
├── package-lock.json   (present when the smoke run installed dependencies)
├── Dockerfile
└── README.md
```

`node_modules/`, `storage/`, `apify_storage/`, `.git/` and `.env` are always excluded.

## Files in `work/<runId>/`

| File | Purpose |
| --- | --- |
| `request.json` | The request plus run metadata, `revision` flag and `previousZip` details. |
| `REQUIREMENTS.md` | Human-readable version of the request, with a "Previous Actor" section for revisions. |
| `previous-actor.zip` | Revision only: the customer's previous Actor as staged by Actor #2. |
| `reported-error.log`, `reported-input.json` | Problem reports only: the customer's pasted log and failing input. |
| `reproduction.json` | Result of `--reproduce`: whether the reported failure reproduced locally. |
| `PROMPT.md` | The task handed to Codex. |
| `codex-last-message.md` | Codex's final summary when run through the CLI. |
| `actor/` | The generated Actor. |
| `validation.json` | Result of the last validation, including the smoke run. |
| `smoke-input.json` | Input used by the smoke run. |
| `<actor-name>.zip`, `zip.json` | The deliverable and its file list plus SHA-256. |
| `upload.json` | Store ID, record URL, archive location and final run status after upload. |

`work/` is ignored by git.

## Self-test without a running Actor #2

```bash
npm run selftest          # structural checks only
npm run selftest -- --run # also installs dependencies and runs the template Actor locally
```

It creates temporary key-value stores in your account and runs two scenarios: a fresh request, then a revision
that starts from the ZIP produced by the first. It checks the uploaded ZIPs, the preserved Actor name and the
archive records, then deletes every temporary store.

## Debugging offline

```bash
node src/pipeline.js TEST01 --from-file request.json --skip-generate --run
node src/pipeline.js TEST02 --from-file request.json --previous-zip some-actor.zip --skip-generate --run
```

`--from-file` loads the request from a local JSON file and skips the upload; `--previous-zip` treats a local ZIP
as the previous Actor so the revision path can be exercised without Apify.

## Customising the template

Edit `template/`. Placeholders: `{{ACTOR_NAME}}` (slug), `{{ACTOR_TITLE}}`, `{{ACTOR_DESCRIPTION}}`,
`{{REQUIREMENTS}}`, `{{REQUIREMENTS_COMMENT}}`, `{{GENERATOR_RUN_ID}}`, `{{GENERATED_AT}}`, `{{LANGUAGE}}`.
Values are JSON-escaped when the target file ends in `.json`.
