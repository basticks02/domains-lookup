# Benchmarking Results

Each implementation should append a JSON record to `results.json` after it completes a domain lookup run. A typical structure is:

```json
{
  "node": [ { /* baseline run metadata */ } ],
  "optimizedNode": [ { /* optimized run metadata */ } ]
}
```

Records should include a timestamp, input parameters, processed domain counts, and timing statistics so runs can be compared across implementations. The baseline Node script (`../node/lookup.js`) and the optimized variant (`../node/optimized-lookup.js`) already follow this convention.

## Automated Runner

`run_benchmarks.py` automates repeated comparisons. Example usage:

```bash
python benchmarking/run_benchmarks.py --runs 5 --letters 3 --limit 1000 --tlds ".com,.io,.dev" --tlds-per-run 2 --concurrency 200
```

The script:

- Executes both Node scripts with identical parameters per run.
- Validates that the availability outputs match.
- Appends metrics to `results.json` and prints aggregate speed-up percentages.
- Optionally writes a summary JSON via `--summary-out`.
