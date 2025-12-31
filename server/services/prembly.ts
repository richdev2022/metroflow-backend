import axios from 'axios';

const PREMBLY_BASE_URL = process.env.PREMBLY_BASE_URL || "https://api.prembly.com";
const API_KEY = process.env.PREMBLY_API_KEY;
const APP_ID = process.env.PREMBLY_APP_ID;
const TIMEOUT_SECONDS = parseInt(process.env.PREMBLY_TIMEOUT_SECONDS || '30', 10);

const premblyClient = axios.create({
    baseURL: PREMBLY_BASE_URL,
    timeout: TIMEOUT_SECONDS * 1000,
    headers: {
        'x-api-key': API_KEY,
        'app-id': APP_ID,
        'Content-Type': 'application/json'
    }
});

export async function verifyBVN(bvn: string) {
    if (!API_KEY || !APP_ID) {
        console.error("Prembly credentials missing");
        throw new Error("KYC service configuration error");
    }

    try {
        const response = await premblyClient.post('/verification/bvn', { number: bvn });
        return response.data;
    } catch (error: any) {
        console.error("BVN Verification Error:", error.response?.data || error.message);
        throw new Error(error.response?.data?.message || "BVN Verification Failed");
    }
}

export async function verifyNIN(nin: string) {
    if (!API_KEY || !APP_ID) {
        console.error("Prembly credentials missing");
        throw new Error("KYC service configuration error");
    }

    try {
        const response = await premblyClient.post('/verification/nin', { number_nin: nin });
        return response.data;
    } catch (error: any) {
        console.error("NIN Verification Error:", error.response?.data || error.message);
        throw new Error(error.response?.data?.message || "NIN Verification Failed");
    }
}
