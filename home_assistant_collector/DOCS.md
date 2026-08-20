# Soter Activity Collector

## Before starting

1. Configure the same entity IDs and kinds in the Soter Activity web dashboard.
2. Put the shared ingest secret in `ingest_secret`. Never commit this value to GitHub.
3. Add at least one entity. Supported kinds are `motion`, `current`, and `power`.

The first start requests up to `history_backfill_hours` of Home Assistant history. It then listens for live `state_changed` events and runs an overlapping hourly history recovery. A persistent queue under `/data` protects readings during internet outages and restarts.

## Options

- `firebase_ingest_url`: Signed HTTPS endpoint. The default is the production Soter endpoint.
- `household_id`: Firebase household identifier.
- `collector_id`: Stable identifier for this Home Assistant installation.
- `ingest_secret`: At least 32 random characters, matching the Firebase Secret Manager value.
- `entities`: Explicit entity allowlist and sensor kind mapping.
- `upload_interval_seconds`: Batch and heartbeat interval.
- `history_backfill_hours`: Initial history recovery period; 336 hours is 14 days.

The app sends state, numeric value, timestamp, unit, and friendly label only. It does not send unrelated Home Assistant entities or attributes.

## Troubleshooting

- `Collector authentication failed`: check that the add-on and Firebase Secret Manager contain exactly the same secret.
- `not in the configured entity allowlist`: save the same entity ID and kind in the web dashboard.
- `History recovery failed`: verify Home Assistant Recorder retains the requested period; live collection will continue retrying.
- A growing queue indicates Firebase cannot be reached or is rejecting the payload. Check the app log before changing or deleting its data.
