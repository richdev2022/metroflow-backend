import axios from "axios";

const endpoints = [
    { url: "https://api.prembly.com/verification/bvn", method: "POST" },
    { url: "https://api.prembly.com/identitypass/verification/bvn", method: "POST" },
    { url: "https://api.prembly.com/api/v1/verification/bvn", method: "POST" },
    { url: "https://sandbox.myidentitypass.com/api/v2/biometrics/merchant/data/verification/bvn", method: "POST" },
    { url: "https://api.myidentitypass.com/api/v2/biometrics/merchant/data/verification/bvn", method: "POST" },
];

const headersVariations = [
    { "x-api-key": process.env.PREMBLY_API_KEY, "app-id": process.env.PREMBLY_APP_ID },
    { "X-API-KEY": process.env.PREMBLY_API_KEY, "app-id": process.env.PREMBLY_APP_ID },
    { "Authorization": `Bearer ${process.env.PREMBLY_API_KEY}`, "app-id": process.env.PREMBLY_APP_ID },
    { "x-api-key": process.env.PREMBLY_API_KEY } // No app-id
];

async function test() {
    console.log("Starting Permutation Test...");
    for (const ep of endpoints) {
        for (const headers of headersVariations) {
            console.log(`Testing ${ep.url} with headers keys: ${Object.keys(headers).join(",")}`);
            try {
                const client = axios.create({
                    headers: { ...headers, "Content-Type": "application/json" },
                    timeout: 5000
                });
                
                // Use a clearly invalid BVN to trigger logic error (success for us) vs auth error
                await client.post(ep.url, { number: "12345678901" });
                console.log(">>> SUCCESS (200 OK) <<<");
                return; // Found it!
            } catch (e: any) {
                const status = e.response?.status;
                const msg = e.response?.data?.message || e.message;
                console.log(`   -> ${status || 'Error'}: ${msg}`);
                
                // If we get 400 or 404 with a specific API message, it might mean Auth worked but data was bad.
                // "Authentication credentials were not provided" -> 401 Auth failed.
                // "BVN not found" -> Auth success!
            }
        }
    }
}

import "dotenv/config";
test();
