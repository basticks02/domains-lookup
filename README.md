# Domains Lookup

A simple benchmarking harness for domain availability checks. The `node/` folder contains both the baseline script (`lookup.js`) and an optimized high-concurrency variant (`optimized-lookup.js`) so you can compare their performance side by side.

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure API credentials:**

   Create a `.env` file in the project root:

   ```env
   GODADDY_API_KEY=your_api_key_here
   GODADDY_API_SECRET=your_api_secret_here
   ```

   Get your API credentials from [GoDaddy Developer Portal](https://developer.godaddy.com/keys).

## Usage

Baseline script:

```bash
node node/lookup.js <number_of_letters> [tlds] [max_domains]
```

Optimized script:

```bash
node node/optimized-lookup.js <number_of_letters> [tlds] [max_domains]
```

### Parameters

- `<number_of_letters>` - Length of domain combinations to generate (e.g., 3 for "abc", "xyz")
- `[tlds]` - (Optional) Comma-separated list of TLDs to check (default: `.com`)
- `[max_domains]` - (Optional) Positive integer cap on how many domains to process before stopping

### Examples

**Check 3-letter .com domains:**

```bash
node node/lookup.js 3
```

**Check 3-letter domains across multiple TLDs:**

```bash
node node/lookup.js 3 .com,.io,.dev
```

**Stop after checking the first 1,000 .com domains (baseline):**

```bash
node node/lookup.js 3 .com 1000
```

**Run the optimized script with 300 max domains of .io:**

```bash
CONCURRENCY_LIMIT=200 node node/optimized-lookup.js 3 .io 300
```

## Output

- Baseline script streams progress logs and saves results to `node/available.node.json`
- Optimized script reports per-batch throughput and saves results to `node/available.optimized.json`

```
{
  ".com": ["abcd.com", "efgh.com"],
  ".io": ["abcd.io"]
}
```

### Example Output

```
🧩 Config: 3-letter combos | TLDs: .com, .io | Limit: no limit
🧮 17,576 possible combinations
🔍 Checking .com domains...
⏱️ Batch time: 812 ms (61.6 domains/s)
🟢 Available: xyz.com
🔴 Taken: abc.com
⏳ Processed 150/17,576 for .com
⚡ .com processed 500 domains in 9.88s (50.6 domains/s)

📈 Overall: 19.78s for 1,000 domains (50.6 domains/s)
📉 Avg batch: 812 ms | Fastest batch: 742 ms | Slowest batch: 925 ms
📦 Benchmark saved to benchmarking/results.json
✅ Done! Results saved to node/available.node.json
```

The optimized runner emits similar output but with additional per-batch timing details and higher overall throughput logs.

## Automated Benchmarks

Run multiple back-to-back comparisons (baseline vs optimized) with the helper script:

```bash
python benchmarking/run_benchmarks.py --runs 5 --letters 3 --limit 1000 --tlds ".com,.io,.dev,.app" --tlds-per-run 2 --concurrency 200 --summary-out benchmarking/summary.json
```

- Each iteration uses the same parameters for both scripts and appends their metrics to `benchmarking/results.json`.
- Availability outputs are compared to ensure both implementations return identical results.
- The optional summary file aggregates average durations, speed-ups, and highlights any mismatches. Use `--dry-run` to preview the planned scenarios without executing the Node scripts.

## Why the Optimized Runner Is Faster

The optimized script preserves the same API contract and batch size as the baseline (`50` domains per request), but removes the inefficiencies that dominate wall time in the original implementation:

- **No fixed inter-batch delay.** The baseline sleeps for `DELAY = 2000ms` after every batch; with 1,000 domains and batch size 50 (20 batches) that alone burns ~40 seconds. The optimized runner eliminates the artificial pause, so wall time mostly reflects actual network work (~0.8s in a sample run).
- **Bounded concurrency.** Instead of awaiting each batch sequentially, the optimized runner uses a semaphore (`CONCURRENCY_LIMIT`, default 200) to 