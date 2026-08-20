# User Guide

## Feedback Learning

The action also learns from your positive feedback (👍 reactions) to improve confidence scoring over time.

### How It Works

- **Thumbs Up (👍)**: Indicates the finding is valuable

The system tracks:

- Which findings get positive reactions
- Provider agreement on findings
- Confidence levels over time

### Configuration

Feedback learning is controlled by these environment variables:

```yaml
- LEARNING_ENABLED: true # Enable feedback learning
- LEARNING_MIN_FEEDBACK_COUNT: 5 # Min feedback before adjusting confidence
- LEARNING_LOOKBACK_DAYS: 30 # How far back to look for feedback
```

See the main [README](../README.md#configuration) for full configuration options.

## Review Depth

Set `review_depth` in `.github/multi-review.yml` to control Action-side review
investigation work:

```yaml
review_depth: balanced # economy | balanced | thorough
```

`balanced` is the default. `thorough` uses larger bounded agent, tool, and state
budgets, while the signed server policy remains the hard ceiling. `economy`
skips investigation and critic calls. `REVIEW_DEPTH` overrides the file value.

## Tips for Effective Review

### Managing Noise

If you're seeing too many low-confidence findings, consider:

1. **Quiet Mode**: Filters findings below a confidence threshold

   ```yaml
   - QUIET_MODE_ENABLED: true
   - QUIET_MIN_CONFIDENCE: 0.6 # Only show findings ≥60% confidence
   ```

2. **Severity Filtering**: Only show critical/major findings

   ```yaml
   - INLINE_MIN_SEVERITY: major # Skip minor findings in inline comments
   ```

3. **Comment Limits**: Cap the number of inline comments
   ```yaml
   - INLINE_MAX_COMMENTS: 20 # Maximum inline comments per review
   ```

### Working with the Summary Comment

The action posts a summary comment on each PR with:

- Overall statistics (critical/major/minor counts)
- All findings grouped by severity
- Performance metrics (duration, cost, providers used)

**On incremental reviews**, the summary comment is updated in place rather than creating a new comment each time.

## Advanced Usage

### Dry Run Mode

Test the action without posting comments:

```yaml
- DRY_RUN: true
```

The action will:

- Run the full review
- Generate all findings and comments
- Log what it would have posted (check Action logs)
- NOT actually post any comments to GitHub

### Custom Severity Thresholds

Control which findings appear in inline comments vs. summary only:

```yaml
# Only post critical findings as inline comments
- INLINE_MIN_SEVERITY: critical

# Require high provider agreement for inline comments
- INLINE_MIN_AGREEMENT: 0.7 # 70% of providers must agree
```

### Performance Optimization

For large PRs, optimize review speed:

```yaml
# Enable incremental mode (reviews only changed files since last run)
- INCREMENTAL_ENABLED: true

# Use faster models for AST analysis
- ENABLE_AST_ANALYSIS: false # Disable AST if not needed

# Limit concurrent provider calls
- PROVIDER_MAX_PARALLEL: 3 # Reduce parallel requests
```

See [analytics.md](analytics.md) for tracking costs and performance.
