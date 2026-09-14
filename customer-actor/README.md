# Actor #1 - Customer Actor

Customers run this Actor in their own Apify account. It sends their request to the private generator
Actor (Actor #2) in your account, waits for the generated Actor, and copies the resulting ZIP into the
customer's run storage.

## Required environment variables

- `TOKEN`: your private Apify token (secret). It must be able to run Actor #2, read its storage, and write to
  the `generated-actors` key-value store in your account.
- `GENERATOR_ACTOR_ID`: Actor #2 ID, for example `dtrungtin/generator-actor`.
- `INBOX_STORE_NAME` (optional): named store in your account used to hand previous ZIPs to Actor #2. Default
  `generated-actors`, the same store Local Codex archives to.

## Input

| Field | Required | Description |
| --- | --- | --- |
| `actorName` | yes | Name of the Actor to generate. Reusing the name of an earlier successful run turns the request into a revision. |
| `requirements` | yes | What the Actor should do. For a revision, only the change. |
| `language` | no | Preferred runtime hint. |
| `notes` | no | Extra information for the generator. |
| `errorLog` | no | Problem report: error message or tail of the failed run's log (secrets removed). |
| `failedRunInput` | no | Problem report: the exact input that failed, as JSON. |
| `failedRunId` | no | Problem report: run ID or Console URL of the failed run, for reference. |

## Flow

1. The customer starts this Actor with the generation requirements.
2. The Actor looks at the customer's own earlier runs of this Actor (see Revisions below).
3. It creates a separate `ApifyClient` using `process.env.TOKEN` and calls Actor #2 in your account.
4. Actor #2 stores the request and waits for Local Codex to upload `GENERATED_ACTOR_ZIP` into its default
   key-value store.
5. When Actor #2 succeeds, this Actor reads the ZIP with your token and stores it as `GENERATED_ACTOR_ZIP`
   in its own default key-value store, plus an `OUTPUT` record with the generator run ID, Actor name and the
   ZIP's record URL (`zipUrl`). The log and the final status message show that URL, for example
   `https://api.apify.com/v2/key-value-stores/<storeId>/records/GENERATED_ACTOR_ZIP`.
6. The customer downloads `GENERATED_ACTOR_ZIP` from that URL (key-value store record URLs are readable without a
   token) or from the run's Storage tab, and imports it into Apify.
7. The same result is pushed as one item into the run's default dataset (`status`, `actorName`, `requestType`,
   `zipUrl`, size, hash, version, billing tier and label, amount charged, `requestId`, timestamps, `message`), so
   it appears as a table in the Dataset tab (`.actor/dataset_schema.json`) and can be exported or read through the
   API. A run that fails writes a `FAILED` item with the error message; a run stopped by the spending-cap pre-check
   writes `NOT_STARTED`. The item never mentions how the Actor is produced.

## Revisions

Revisions are detected automatically; there is no extra input. A request whose `actorName` matches an Actor
already delivered to the same customer (compared case-insensitively, ignoring punctuation) is a revision of it.
Two lookups exist:

1. **From the customer's runs (needs full permissions).** Using the run's own token, the Actor lists the
   customer's `SUCCEEDED` runs of this Actor, picks the newest one with a matching `INPUT.actorName` and a
   delivered ZIP, downloads that ZIP, uploads it into the `generated-actors` store in **your** account as
   `inbox-<runId>.zip` (Actor #2 cannot read the customer's private storage) and passes the record URL to
   Actor #2 as `previousZipUrl` with its SHA-256 and the previous run IDs. Apify runs new Actors with
   **limited permissions**, whose token cannot list the user's runs, so this lookup fails with "Insufficient
   permissions" unless you switch the Actor to full permissions in Console (Settings > Actor permissions).
   Customers then have to approve that access explicitly. The failure is logged and is not fatal.
2. **From your delivery records (default, no customer permissions needed).** Actor #2 checks the per-customer
   delivery index that Local Codex writes on every upload (`index-<customerUserId>.json` in the
   `generated-actors` store, keyed by normalised Actor name). The customer's user ID comes from the
   `APIFY_USER_ID` environment variable of this run. A match makes Actor #2 stage the original delivery from
   your own storage, which is trusted by construction.

`OUTPUT.revision` reflects Actor #2's decision. To generate a brand-new Actor instead, use a different
`actorName`.

## Reporting a problem with a generated Actor

When an Actor the customer received fails in their account, that run's log and input live in the customer's
account and cannot be read from here (limited permissions). The customer therefore attaches the evidence in the
"Report a problem" section of the input: `errorLog`, `failedRunInput` and optionally `failedRunId`, keeping the
same `actorName` so the request becomes a revision. The Actor bundles them as `problemReport` (the log is capped at
200,000 characters, keeping the tail where errors appear), forwards it to Actor #2 and logs only metadata about it,
never its content. Local Codex saves the evidence next to the request, reproduces the failure with the reported
input, and the fix is delivered as a new version. The input description asks customers to remove secrets first.

## Pricing

Built for pay per event (`src/pricing.js` holds the rules). When monetisation is enabled in Console with the events
`actor-generated-standard`, `actor-generated-advanced` and `actor-revision`:

1. At start the run must be able to pay for `actor-generated-standard`; otherwise it exits with a status message
   asking the customer to raise the run's maximum total charge, before the generator is contacted.
2. The customer's cap and the prices are forwarded in `customerContext.billing`; Local Codex decides the tier
   automatically from the delivered code (complexity), the size of the change against the previous version and
   the 7-day warranty for problem reports (counted from the last billable delivery of that Actor, so free fixes do
   not extend it), and records it with a label in `GENERATED_ACTOR_META`.
3. After the ZIP is copied, the event for that tier is charged: `actor-revision` for updates,
   `actor-generated-standard` or `actor-generated-advanced` for new Actors and major reworks (advanced falls back to
   standard if the cap is too low); free deliveries charge nothing. The customer sees the amount and the label,
   e.g. "Charged $19.00 for this delivery (update of an existing Actor)". `OUTPUT.charge` records the result.

Without monetisation the Actor charges nothing and runs as pay per usage.

## Failure reporting

Errors go through `Actor.fail()`, so a failed run is marked `FAILED` and the reason is shown as its status
message. Calling `Actor.exit()` in a `finally` block would exit with code 0 and hide the failure.
