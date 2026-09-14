# Two-Actor Generator Architecture

A customer describes the Actor they need. Their request travels through two Actors to your machine, where
Local Codex generates, tests and packages the Actor. The finished ZIP travels back the same way, and the
customer imports it into their own Apify account. Customers can later request a revision of an Actor they
received, and the pipeline starts from the original code instead of a blank template.

```text
Customer
  │
  ▼
Actor #1  customer-actor/      runs in the CUSTOMER's account
  │  calls Actor #2 with your TOKEN and waits
  │  (revision: finds the customer's earlier run with the same Actor name,
  │   copies its ZIP into your account and passes the URL to Actor #2)
  ▼
Actor #2  generator-actor/     runs in YOUR account
  │  stores GENERATION_REQUEST, logs its Run ID, waits for GENERATED_ACTOR_ZIP
  │  (revision: downloads the previous ZIP, checks it against the original delivery,
  │   stages it as PREVIOUS_ACTOR_ZIP first)
  ▼
You copy the Generator Run ID
  │
  ▼
Local Codex  local-codex/      runs on your machine
  │  fetch request -> scaffold (template or previous ZIP) -> generate -> validate/test -> zip -> upload + archive
  ▼
Actor #2 sees GENERATED_ACTOR_ZIP and finishes
  │
  ▼
Actor #1 copies the ZIP into its own run storage and finishes
  │
  ▼
Customer downloads the ZIP and imports it into Apify
```

## Repository layout

| Folder | Runs where | Purpose |
| --- | --- | --- |
| `customer-actor/` | Customer's Apify account | Actor #1. Submits the request, waits, copies the ZIP back for the customer. |
| `generator-actor/` | Your Apify account | Actor #2. Stores the request, stages previous ZIPs for revisions, waits for the ZIP. |
| `local-codex/` | Your machine | Fetch, scaffold, generate, validate, zip, upload and archive. See its README. |
| `local-codex/template/` | Inside the ZIP | Starting layout of every newly generated Actor. |

## Account boundary

- Actor #1 runs in the customer's account. Its `TOKEN` environment variable holds **your** Apify token, so the
  `ApifyClient` it creates acts against **your** account.
- Actor #2 therefore runs, and stores its request and ZIP, in your account.
- Local Codex uses your token as well and only touches Actor #2's run storage and the `generated-actors` archive.
- Actor #1 copies the finished ZIP into its own run key-value store with `Actor.setValue()`, which is the
  customer's storage. That is where the customer downloads from.
- Revisions are detected automatically: same customer (Apify user ID) and same Actor name as an earlier
  delivery. By default Actor #2 finds the earlier delivery in the per-customer index that Local Codex keeps in
  the `generated-actors` store and stages your own archived copy, so nothing is read from customer storage. If
  you switch Actor #1 to full permissions, it can additionally read the customer's earlier run, copy that ZIP
  into your account and pass its URL; Actor #2 then compares it with the hash of the original delivery and
  Local Codex smoke-runs only verified ZIPs unless you override after reviewing the code. Apify's default
  limited permissions do not allow an Actor to list the user's runs, which is why the index path exists.

**Security note:** Actor #1 executes in a customer's environment with your token embedded. Use a dedicated Apify
account or a token with the minimum rights needed to run Actor #2 and read its storage.

## Key-value store records

| Key | Store | Written by | Content |
| --- | --- | --- | --- |
| `GENERATION_REQUEST` | Actor #2 run | Actor #2 | The customer's request plus run metadata; `revision` and `previousZip` for revisions. |
| `GENERATION_STATUS` | Actor #2 run | Actor #2 | `WAITING_FOR_LOCAL_CODEX`, then `COMPLETED`. |
| `inbox-<customerRunId>.zip` | named store `generated-actors` | Actor #1 | Revision only: the customer's previous ZIP handed to Actor #2, deleted once staged. |
| `PREVIOUS_ACTOR_ZIP` | Actor #2 run | Actor #2 | Revision only: the previous Actor as staged for Local Codex, with an integrity verdict in `GENERATION_REQUEST`. |
| `GENERATED_ACTOR_ZIP` | Actor #2 run, then Actor #1 run | Local Codex, copied by Actor #1 | The Actor ZIP, `application/zip`. |
| `GENERATED_ACTOR_META` | Actor #2 run | Local Codex | File list, size, SHA-256, revision flag. |
| `<generatorRunId>.zip` / `.json` | named store `generated-actors` | Local Codex | Permanent archive of every delivered ZIP and its request, used for revisions after run storage expires. |
| `index-<customerUserId>.json` | named store `generated-actors` | Local Codex | Per-customer map of normalised Actor name to the latest generator run; Actor #2 uses it to recognise revisions. |
| `OUTPUT` | both runs | Both Actors | Run summary with `zipUrl` (the ZIP's record URL, also printed in the log and status message); Actor #1's includes `generatorRunId`, which later revisions rely on. |

## Dataset items

Both Actors also push exactly one item into their run's default dataset, so results show up in the Console's
Dataset tab as a table (`.actor/dataset_schema.json` defines the views), can be exported as CSV or JSON, and can be
listed across runs through the API. The item is written on success, on failure (`status: FAILED` with the error
message) and, for Actor #1, when the run stops before contacting the generator because the spending cap is too low
(`status: NOT_STARTED`).

| Actor | Item content |
| --- | --- |
| Actor #1 (customer sees it) | `status`, `actorName`, `requestType` (`new`, `update`, `fix`), `zipUrl`, `zipBytes`, `zipSha256`, `zipFiles`, `generatedActorVersion`, `tier`, `chargeLabel`, `charged`, `chargedUsd`, `requestId`, `previousRunId`, timestamps and a one-line `message`. Nothing about how the Actor was produced. |
| Actor #2 (your account) | The request (`actorName`, `requirements`, `language`, customer user and run IDs, submission time, the customer's pay-per-event cap), the revision lookup (`previousLookup`, `previousSource`, `previousIntegrity`, previous run IDs, `previousLookupError`), and the delivery's billing decision from `GENERATED_ACTOR_META` (`tier`, `chargeEvent`, `billingLabel`, `billingReasons`, `complexityScore`, `changedRatio`, `warrantyAnchorAt`), plus ZIP size, hash, file count and version. The "Requests" view is a per-request overview; "Revision details" shows how the previous version was found. |

## Deploying the two Actors

Both Actors live in the `dtrungtin` account as `dtrungtin/generator-actor` and `dtrungtin/customer-actor`
(first pushed 2026-09-13). Redeploy after changes from each folder:

```bash
cd generator-actor && apify push
cd customer-actor  && apify push
```

Apify rejects input schemas whose fields lack a `description`, so keep every property documented.

Then in Apify Console:

- **Actor #2**: set the default run timeout generously (or to 0 for unlimited), since it waits for a human. Add a
  `TOKEN` secret environment variable (your token) or switch it to full permissions so it can read the
  `generated-actors` store for revision detection; Apify's default limited permissions do not allow that.
- **Actor #1**: add the environment variables `TOKEN` (your Apify token, marked secret) and
  `GENERATOR_ACTOR_ID` (for example `dtrungtin/generator-actor`). Also raise its default run timeout: it waits
  as long as Actor #2 does. Actor #1 calls Actor #2 with `timeout: 0`, which the Apify client documents as
  "no timeout", and waits for the run to finish.
- Both Actors only wait and copy a small file, peaking around 50 to 70 MB, so both are fixed at 128 MB (Apify's
  minimum) as default, minimum and maximum in their `actor.json`. Actor #1 also starts the generator with
  `memory: 128` explicitly (`GENERATOR_MEMORY_MBYTES` to override).

## Pricing (pay per event)

The customer Actor is written for Apify's pay-per-event model and charges only when a delivery lands in the
customer's storage. Nothing is charged until you enable monetisation in Apify Console (customer Actor >
**Publication** > **Monetization** > **Pay per event**) and define these events, whose names the code relies on:

| Event | Suggested price | Charged when |
| --- | --- | --- |
| `actor-generated-standard` | $49 | a new Actor is delivered (default tier) |
| `actor-generated-advanced` | $149 | you deliver with `--tier advanced` (login, anti-blocking, browser automation, multi-step flows) |
| `actor-revision` | $19 | a revision of an Actor the customer already received (default for revisions) |
| `apify-actor-start` | keep Apify's default | every run start (built-in event) |

How it works:

- **Before any work starts**, Actor #1 checks that the run's "Maximum total charge" covers the standard price. If
  not, it exits successfully without contacting the generator and tells the customer to raise the limit. Free-plan
  customers are excluded by this rule as well, since their credits are far below the price and Apify does not pay
  out revenue from free-plan users.
- **The tier is decided automatically** when Local Codex uploads the ZIP (`local-codex/src/billing.js`), from
  measurable facts only; no human judgement is involved:

  | Situation | Tier | Event |
  | --- | --- | --- |
  | New Actor, complexity score below 2 | standard | `actor-generated-standard` |
  | New Actor, complexity score 2 or more | advanced | `actor-generated-advanced` |
  | Revision whose code, schema and dependencies are unchanged (only docs, comments, version) | free | none |
  | Problem report within 7 days of the last billable delivery | free (warranty) | none |
  | Revision changing 40% or more of functional lines, or adding 2 or more source files | like a new Actor, by complexity | standard or advanced event |
  | Any other revision (including problem reports after the warranty) | revision | `actor-revision` |

  Complexity score: browser automation (Playwright, Puppeteer, browser crawlers) 2 points; authentication or secret
  inputs 1; 500 or more functional source lines 1; 8 or more input fields 1; third-party service integrations
  (OpenAI, AWS, databases, ...) 1. The decision, its reasons and the measurements are stored in
  `GENERATED_ACTOR_META.billing` and printed by the upload step. `--tier` remains as an override for exceptions.

  The warranty counts from the **last billable delivery** of that Actor, not from the last delivery. Every delivery
  records a `warrantyAnchorAt` in the archive and the delivery index: a billable tier (standard, advanced, revision)
  sets it to the upload time, a free delivery (warranty fix, unchanged re-delivery, `--tier free`) carries the
  previous anchor forward. A customer therefore gets one 7-day window per paid delivery; a chain of free fixes cannot
  extend it. Deliveries archived before this field existed count from their upload date.
- **After copying the ZIP**, Actor #1 charges the event for that tier and tells the customer, for example
  "Charged $19.00 for this delivery (update of an existing Actor)" or "No charge for this delivery (fix under
  warranty)". An advanced delivery that the cap cannot cover falls back to the standard event. The outcome is
  recorded in `OUTPUT.charge`.
- While monetisation is off, `isPayPerEvent` is false and the Actor charges nothing; the code paths are inert.

Keep memory low on both Actors: under pay per event, Actor #1's compute while waiting is deducted from your 80%
share.

## Operating a request

1. The customer starts Actor #1 with `actorName`, `requirements` and optional `language` and `notes`. Reusing
   the `actorName` of one of their earlier successful runs makes it a revision of that Actor, so they describe
   only the change. A new name means a new Actor. If a delivered Actor fails for them, they fill in the
   "Report a problem" fields (`errorLog`, `failedRunInput`, `failedRunId`); the evidence travels with the request
   and Local Codex reproduces the failure with their input before fixing it (`--reproduce`).
2. Actor #2 starts in your account. Its status message reads `Generating "<name>" (new Actor | update of an
   existing Actor). Request ID: <generatorRunId>`. The customer's run log never shows this step: Actor #1 calls
   the generator with log streaming off and only reports that generation is in progress, and every message in
   both Actors is worded so nothing reveals how the Actor is produced.
3. On your machine:

   ```bash
   cd local-codex
   npm install                                  # first time only
   export APIFY_TOKEN=<your token>              # PowerShell: $env:APIFY_TOKEN = "<your token>"
   npm run pipeline -- <generatorRunId> --run
   ```

   Without the Codex CLI, the pipeline stops after writing `work/<runId>/PROMPT.md`. Run Codex on
   `work/<runId>/actor/` with that prompt, then continue with
   `npm run pipeline -- <generatorRunId> --skip-generate --run`. For a revision the working folder already
   holds the customer's previous Actor and the prompt describes the change.
4. The upload step reports when Actor #2 reaches `SUCCEEDED`. Actor #1 then copies the ZIP and finishes.
5. The customer opens their Actor #1 run, **Storage > Key-value store**, and downloads `GENERATED_ACTOR_ZIP`.

## How the customer imports the ZIP into Apify

The ZIP has `.actor/actor.json`, `src/main.js`, `package.json`, `Dockerfile` and `README.md` at its root, so any
of these work:

- **Apify CLI (simplest and most robust).** Unzip, then inside the folder:

  ```bash
  apify login
  apify push
  ```

  This creates the Actor in the customer's account and starts the first build. For a revision, `apify push`
  from the new ZIP updates the same Actor because `.actor/actor.json` keeps its `name`.

- **Apify Console, Zip file source.** Actors > Development > **Develop new** > **Empty**. On the new Actor open
  the **Source** tab, switch the source type from **Web IDE** to **Zip file**, paste a URL that serves the ZIP
  and click **Save**, then **Build**. The Actor #1 record URL printed in the run log works as is, since key-value
  store record URLs are readable without a token:
  `https://api.apify.com/v2/key-value-stores/<storeId>/records/GENERATED_ACTOR_ZIP`.
  Zip sources do not rebuild automatically and the URL must stay reachable (run storage expires), so the CLI
  route is preferred.

- **Apify API.** Create the Actor with a version of `sourceType: "TARBALL"` and `tarballUrl` pointing at the
  ZIP, then trigger a build.

## Local development notes

- Both Actors use `apify/actor-node:22`. Run either locally with `apify run` inside its folder.
- Actor #2 polls its key-value store every `POLL_INTERVAL_MS` (default 10 s).
- Report failures with `Actor.fail()` from the catch block. `Actor.exit()` in a `finally` block exits with code
  0 after a throw and marks the run `SUCCEEDED`; the Local Codex validator rejects that pattern.
- `local-codex/README.md` documents every script, the generation options and `npm run selftest`, which
  exercises the fresh, revision and archive paths against temporary key-value stores without a running Actor #2.
