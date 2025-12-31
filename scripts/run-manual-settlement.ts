
import axios from 'axios';

const REF = 'FUND-user-1767003494300-756f12b2';
const TOKEN = 'eyJhZG1pbklkIjoiMWFmZTNmNDYtOWJkZS00MzZlLWE0OWQtMWRmNWI5ZGYwOTIxIiwicm9sZSI6InBsYXRmb3JtX2FkbWluIiwiaWF0IjoxNzY2OTc0MjAwLCJleHAiOjE3NjcwNjA2MDB9';
const URL = 'http://localhost:3000/api/admin/transactions/settle';

async function run() {
    try {
        console.log(`Sending settlement request for ${REF}...`);
        const response = await axios.post(
            URL,
            { reference: REF, force: true },
            {
                headers: {
                    'Authorization': `Bearer ${TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('Success:', response.data);
    } catch (error: any) {
        if (error.response) {
            console.error('Error Response:', error.response.status, error.response.data);
        } else if (error.request) {
            console.error('Error Request:', error.message); // Request made but no response
        } else {
            console.error('Error Setup:', error.message);
        }
    }
}

run();
