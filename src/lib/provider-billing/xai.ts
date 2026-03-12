import {
  defaultCollectorUnavailable,
  resolveBillingCredential,
  saveProviderCollectorStatus,
  upsertProviderBillingBuckets,
  utcDayRange,
  type CollectorResult,
  type NormalizedProviderBillingBucket,
} from "@/lib/provider-billing/shared";

type XaiUsageRow = {
  date?: string;
  model?: string;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  spend_usd?: number;
  cost?: number;
};

type XaiUsageResponse = {
  data?: XaiUsageRow[];
  usage?: XaiUsageRow[];
};

export async function collectXaiBilling(): Promise<CollectorResult> {
  const key = await resolveBillingCredential(["XAI_MANAGEMENT_KEY"]);
  if (!key.value) {
    const unavailable = defaultCollectorUnavailable("xai", key.requiredCredential);
    await saveProviderCollectorStatus(unavailable);
    return unavailable;
  }

  const team = await resolveBillingCredential(["XAI_TEAM_ID"]);
  if (!team.value) {
    const unavailable: CollectorResult = {
      provider: "xai",
      available: false,
      reason: "xAI billing usage requires XAI_TEAM_ID in addition to management key.",
      requiredCredential: "XAI_TEAM_ID",
    };
    await saveProviderCollectorStatus(unavailable);
    return unavailable;
  }

  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team.value)}/usage`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
        granularity: "day",
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`xAI usage returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await res.json()) as XaiUsageResponse;
    const rowsRaw = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.usage)
        ? payload.usage
        : [];

    const fetchedAtMs = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);
    const rows: NormalizedProviderBillingBucket[] = rowsRaw
      .map<NormalizedProviderBillingBucket>((row) => {
      const date = row.date || todayStr;
      const { bucketStartMs, bucketEndMs } = utcDayRange(date);
      const spendUsd = Number.isFinite(row.spend_usd)
        ? Number(row.spend_usd)
        : Number.isFinite(row.cost)
          ? Number(row.cost)
          : null;
      const requests = Number.isFinite(row.requests) ? Number(row.requests) : null;
      const inputTokens = Number.isFinite(row.input_tokens) ? Number(row.input_tokens) : null;
      const outputTokens = Number.isFinite(row.output_tokens) ? Number(row.output_tokens) : null;
      const reasoningTokens = Number.isFinite(row.reasoning_tokens) ? Number(row.reasoning_tokens) : null;
      return {
        provider: "xai",
        accountScope: team.value || "default",
        fullModel: row.model || null,
        bucketStartMs,
        bucketEndMs,
        bucketGranularity: "day",
        currency: "USD",
        requests,
        inputTokens,
        outputTokens,
        reasoningTokens,
        spendUsd,
        providerReference: null,
        payload: row,
        dataLatencyNote: date === todayStr ? "Current-day usage may lag provider reporting." : null,
        isFinal: date !== todayStr,
      };
    })
      .filter(
        (row) =>
          row.spendUsd !== null ||
          row.requests !== null ||
          row.inputTokens !== null ||
          row.outputTokens !== null ||
          row.reasoningTokens !== null,
      );

    await upsertProviderBillingBuckets(rows, fetchedAtMs);
    if (rows.length === 0) {
      const result: CollectorResult = {
        provider: "xai",
        available: false,
        reason: "xAI usage API returned no billable rows for the selected date range.",
        requiredCredential: "XAI_MANAGEMENT_KEY",
      };
      await saveProviderCollectorStatus(result);
      return result;
    }
    const result: CollectorResult = {
      provider: "xai",
      available: true,
      fetchedAtMs,
      bucketCount: rows.length,
    };
    await saveProviderCollectorStatus(result);
    return result;
  } catch (err) {
    const result: CollectorResult = {
      provider: "xai",
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      requiredCredential: "XAI_MANAGEMENT_KEY",
    };
    await saveProviderCollectorStatus(result);
    return result;
  }
}
