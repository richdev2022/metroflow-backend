/**
 * Bills fulfilment provider — the pluggable VTU/bills aggregator behind the
 * Bills Hub revenue feature.
 *
 * When BILLS_PROVIDER_URL (+ optional BILLS_PROVIDER_API_KEY) is configured
 * the payload is forwarded to that HTTP endpoint, which is expected to return
 * `{ ok: true, reference }` on success. When no provider is configured the
 * built-in simulator settles the bill instantly (fulfilment_mode
 * 'simulated') so the whole flow — wallet debit, convenience fee, ledger —
 * stays fully exercisable in staging/sandbox environments.
 */

export interface BillFulfilmentRequest {
    reference: string;
    category: string;      // airtime | data | tv | electricity | betting
    providerCode: string;  // mtn | dstv | ikedc | bet9k | ...
    planCode?: string | null;
    amount: number;
    customerRef: string;   // phone | smartcard | meter | customer id
    customerPhone?: string | null;
}

export interface BillFulfilmentResult {
    ok: boolean;
    mode: "provider" | "simulated";
    providerReference?: string | null;
    message?: string;
}

export function isBillsProviderConfigured(): boolean {
    return !!process.env.BILLS_PROVIDER_URL;
}

export async function fulfilBill(request: BillFulfilmentRequest): Promise<BillFulfilmentResult> {
    if (!isBillsProviderConfigured()) {
        // Simulated fulfilment — instant success, clearly labelled.
        return {
            ok: true,
            mode: "simulated",
            providerReference: `SIM-${request.reference}`,
            message: "Bill fulfilled by the built-in simulator (no live bills provider configured).",
        };
    }

    const url = process.env.BILLS_PROVIDER_URL as string;
    const apiKey = process.env.BILLS_PROVIDER_API_KEY;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok || body?.ok === false) {
            return {
                ok: false,
                mode: "provider",
                message: body?.message || body?.error || `Bills provider responded with status ${res.status}`,
            };
        }
        return {
            ok: true,
            mode: "provider",
            providerReference: body?.reference || body?.data?.reference || null,
        };
    } catch (error: any) {
        return {
            ok: false,
            mode: "provider",
            message: error?.name === "AbortError" ? "Bills provider timed out" : (error?.message || "Bills provider request failed"),
        };
    } finally {
        clearTimeout(timeout);
    }
}
