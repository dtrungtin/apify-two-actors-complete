# Actor #2 - Generator Actor

Runs in your Apify account.

## Flow

1. Actor #1 calls this Actor using your Apify token.
2. This Actor stores the full request in `GENERATION_REQUEST` in its default key-value store and sets
   `GENERATION_STATUS` to `WAITING_FOR_LOCAL_CODEX`.
3. It sets its status message to `Generating "<name>" (new Actor | update of an existing Actor). Request ID: <runId>`
   and waits. The log wording is neutral (no mention of a manual step or of Local Codex), and Actor #1 calls this
   Actor with log streaming disabled, so customers never see this log anyway.
4. You copy that run ID and run the Local Codex tooling on your machine:

   ```bash
   cd ../local-codex
   npm run pipeline -- <runId> --run
   ```

   It fetches the request, generates the Actor, tests it locally, zips it, uploads the ZIP to this run's
   default key-value store as `GENERATED_ACTOR_ZIP` (`application/zip`), and archives a copy.
5. This Actor detects the ZIP on its next poll (every `POLL_INTERVAL_MS`, default 10 s), writes
   `GENERATION_STATUS` = `COMPLETED` and `OUTPUT`, pushes one summary item into the run's default dataset, and exits
   successfully.
6. Actor #1's `call()` returns and Actor #1 copies the ZIP into the customer's own run storage.

## Dataset item

Every run ends with exactly one item in its default dataset (also on failure, with `status: FAILED` and the error
message). It combines the request (`actorName`, `requirements`, `language`, `customerUserId`, `customerRunId`,
`submittedAt`, the customer's pay-per-event cap, `problemReported`, `failedRunId`), the revision lookup
(`requestType` new/update/fix, `previousLookup`, `previousSource`, `previousIntegrity`, previous run IDs,
`previousLookupError`) and the delivery as recorded by Local Codex in `GENERATED_ACTOR_META` (`generatedActorName`,
`generatedActorVersion`, `zipBytes`, `zipSha256`, `zipFiles`, `tier`, `chargeEvent`, `billingLabel`,
`billingReasons`, `complexityScore`, `changedRatio`, `warrantyAnchorAt`, `uploadedAt`). `.actor/dataset_schema.json`
defines two Console views: "Requests" (one line per request with its billing outcome) and "Revision details". Because
every run of this Actor is a request, the dataset of all runs is your request ledger.

## Revisions

A request is a revision when the same customer already received an Actor with the same name. Two ways to find
the previous delivery are supported:

- **Passed by Actor #1** (`previousZipUrl`, `previousZipSha256`, `previousCustomerRunId`,
  `previousGeneratorRunId`, `previousActorName`). Actor #1 can only do this when it runs with full permissions
  and may read the customer's earlier runs.
- **Delivery index** (default). When none of those fields is present, this Actor reads
  `index-<customerUserId>.json` from the archive store (`ARCHIVE_STORE_NAME`, default `generated-actors`). Local
  Codex updates that record on every upload, mapping the normalised Actor name to the latest generator run for
  that customer. The customer user ID comes from `customerContext.customerUserId`, which Actor #1 fills from its
  `APIFY_USER_ID`. A hit is treated exactly like `previousGeneratorRunId` from input; `previousZip.lookup` records
  which path was used (`input` or `archive-index`).

Before announcing the request, this Actor stages the previous Actor:

1. It downloads `previousZipUrl` when given. Apify record URLs are read with this account's token (Actor #1 uploads the ZIP
   into the `generated-actors` store here as `inbox-<runId>.zip`); other URLs are fetched over HTTP. The file must
   be a ZIP under 10 MB containing `.actor/actor.json`, and it must match `previousZipSha256`.
2. If no URL was given, or it failed, it falls back to the previous generator run's own `GENERATED_ACTOR_ZIP`,
   then to `<runId>.zip` in the archive store (`ARCHIVE_STORE_NAME`, default `generated-actors`).
3. It compares the ZIP with the SHA-256 of the original delivery (from the previous run's
   `GENERATED_ACTOR_META` or the archive) and records `integrity` as `verified`, `modified` or `unknown`.
   Local Codex only smoke-runs verified ZIPs without an explicit override.
4. It checks that the previous request was made from `previousCustomerRunId` and, when recorded, by the same
   customer user ID. A mismatch fails the run.
5. It copies the ZIP into its own default key-value store as `PREVIOUS_ACTOR_ZIP` and deletes the inbox record.

`GENERATION_REQUEST` then contains `revision: true` and a `previousZip` object (key, bytes, sha256, source, url,
integrity, previous name and requirements), and Local Codex starts from that ZIP instead of the template.

## Problem reports

When the customer reports a failure of an Actor they received, Actor #1 passes `problemReport` (`errorLog`,
`errorLogTruncated`, `errorLogChars`, `failedRunInput`, `failedRunId`, `reportedAt`). It is stored verbatim in
`GENERATION_REQUEST`; the log only records metadata (log length, whether an input was attached, failed run ID),
because the pasted log may contain the customer's secrets. The status message then says "fix for an existing Actor".

## Settings

Set the default run timeout in Apify Console generously (or to 0 for unlimited): this Actor stays alive until a
human finishes the generation. Actor #1 already starts it with `timeout: 0` and `memory: 128`. Memory is fixed at
128 MB (default, minimum and maximum in `actor.json`); the Actor peaks around 65 MB.

**Access to the archive store.** Apify runs Actors with limited permissions by default, and that run token can
read storages of this Actor's earlier runs but not the named `generated-actors` store. For revision detection
this Actor therefore needs one of:

- `TOKEN` environment variable (your Apify token, marked secret) on this Actor, used for archive and index reads; or
- the Actor switched to full permissions in Console (Settings > Actor permissions). This Actor is private and only
  ever run by your own token, so no customer has to approve anything.

Without either, revision lookups fail softly: the request is treated as a new Actor and `GENERATION_REQUEST`
carries `previousLookupError`, which Local Codex prints as a warning.

## Failure reporting

Errors go through `Actor.fail()`, so a failed run is marked `FAILED` with the reason as its status message.

## Uploading the ZIP by hand

If you ever need to bypass the tooling, this is all it does at the end, using a token for your account:

```js
const run = await client.run(generatorRunId).get();
const kvs = client.keyValueStore(run.defaultKeyValueStoreId);

await kvs.setRecord({
    key: 'GENERATED_ACTOR_ZIP',
    value: zipBuffer,
    contentType: 'application/zip',
});
```
